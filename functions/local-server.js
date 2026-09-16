"use strict";
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const {createHash, randomUUID} = require("node:crypto");
const {initializeApp, getApps} = require("firebase-admin/app");
const {getAuth} = require("firebase-admin/auth");
const {LocalStore} = require("./src/local-store");
const {commitChanges, profileSchema} = require("./src/local-api-validation");
const {ID, problem} = require("./src/contracts");
const {createJob, processJob, assertOwner} = require("./src/jobs");
const {MAX_FILE} = require("./src/extraction");
const {sealCase} = require("./src/seal");

const COLLECTIONS = ["cases", "claims", "events", "evidence", "relationships", "analysisResults", "auditLogs", "processingJobs", "aiSuggestions", "caseAnalyses", "seals"];
const MIME_TYPES = /^(image\/(png|jpeg|webp|gif|heic|heif|tiff|bmp)|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+|text\/[a-z0-9.+-]+|message\/rfc822|application\/(pdf|json|xml|rtf|octet-stream|msword|vnd\.[a-z0-9.+-]+))$/i;
const STATUS = {"invalid-argument": 400, "unauthenticated": 401, "permission-denied": 403, "not-found": 404, "failed-precondition": 409, "resource-exhausted": 429, "file-limit": 413};
function safePath(directory, objectPath) {
  const target = path.resolve(directory, objectPath);
  if (!target.startsWith(`${path.resolve(directory)}${path.sep}`)) throw problem("permission-denied", "Invalid file location.");
  return target;
}
function send(response, status, body) {
  response.writeHead(status, {"Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"});
  response.end(JSON.stringify(body));
}
async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw problem("file-limit", "This request exceeds the 2 MB metadata limit.");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw problem("invalid-argument", "The request must contain valid JSON."); }
}

async function createLocalServer({directory, authenticate, apiKey, sealKey, projectId = "d-dectect", origins = []} = {}) {
  const root = path.resolve(directory || path.join(__dirname, ".data"));
  const db = await new LocalStore(root).open();
  const originals = path.join(root, "originals");
  const allowedOrigins = new Set([...origins, "http://localhost:8081", "http://127.0.0.1:8081", "http://localhost:8082", "http://127.0.0.1:8082", "http://localhost:8083", "http://127.0.0.1:8083"]);
  if (!authenticate) {
    if (!getApps().length) initializeApp({projectId});
    authenticate = async (token) => getAuth().verifyIdToken(token);
  }
  const bucket = {file: (objectPath) => ({
    getMetadata: async () => {
      const stored = db.data.files?.[objectPath];
      if (!stored) throw problem("not-found", "The original file is unavailable. Upload it again.");
      return [{size: stored.size, contentType: stored.contentType}];
    },
    download: async () => [await fs.readFile(safePath(originals, objectPath))],
  })};
  const enqueueEvidence = async (uid, caseId, evidenceId) => {
    try { return await createJob(db, uid, "EVIDENCE", {caseId, evidenceId}); } catch (error) {
      const message = error.safe ? error.message : "Processing could not be queued. Your original is saved; retry processing.";
      await db.collection("evidence").doc(evidenceId).update({state: "FAILED", failureReason: message.slice(0, 600), updatedAt: Date.now()});
      return {state: "FAILED", processingError: message};
    }
  };

  const server = http.createServer(async (request, response) => {
    const origin = request.headers.origin;
    if (origin && !allowedOrigins.has(origin)) { send(response, 403, {error: "This web origin is not allowed."}); return; }
    if (origin) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Vary", "Origin");
    }
    response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    response.setHeader("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS");
    if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
    const route = new URL(request.url, "http://localhost").pathname;
    if (route === "/health" && request.method === "GET") { send(response, 200, {ok: true, storage: "private-local", version: 1}); return; }
    try {
      const match = /^Bearer ([^\s]+)$/.exec(request.headers.authorization || "");
      if (!match) throw problem("unauthenticated", "Sign in to access your cases.");
      let identity;
      try { identity = await authenticate(match[1]); } catch { throw problem("unauthenticated", "Your sign-in has expired. Sign in again."); }
      const uid = identity.uid || identity.sub;
      if (!ID.test(uid || "")) throw problem("unauthenticated", "This account identifier is not supported.");

      if (route === "/api/workspace" && request.method === "GET") {
        await db.tail;
        const workspace = Object.fromEntries(COLLECTIONS.map((name) => [name, Object.values(db.data[name] || {}).filter((item) => item.ownerId === uid)]));
        send(response, 200, workspace); return;
      }
      if (route === "/api/profile") {
        const ref = db.collection("users").doc(uid);
        if (request.method === "GET") { const item = await ref.get(); send(response, 200, item.exists ? item.data() : null); return; }
        if (request.method === "PUT") {
          const result = profileSchema.safeParse(await readJson(request));
          if (!result.success || result.data.id !== uid || result.data.ownerId !== uid) throw problem("invalid-argument", "Your profile details are invalid.");
          if (result.data.photoURL && !/^https:\/\//.test(result.data.photoURL)) throw problem("invalid-argument", "Profile photos must use a secure HTTPS address.");
          const prior = await ref.get();
          const profile = {...result.data, email: identity.email || result.data.email, createdAt: prior.exists ? prior.data().createdAt : Date.now(), updatedAt: Date.now()};
          await ref.set(profile); send(response, 200, {ok: true}); return;
        }
      }
      if (route === "/api/commit" && request.method === "POST") {
        const body = await readJson(request);
        const result = await commitChanges(db, uid, body.changes, {expectedAbsentCaseId: body.expectedAbsentCaseId});
        for (const change of body.changes) {
          if (change.op === "put" && change.collection === "evidence" && change.record.kind === "NOTE" && change.record.state === "QUEUED") {
            const current = await db.collection("evidence").doc(change.record.id).get();
            if (current.exists && current.data().state === "QUEUED") await enqueueEvidence(uid, change.record.caseId, change.record.id);
          }
        }
        send(response, 200, result); return;
      }
      const analysisRoute = /^\/api\/cases\/([A-Za-z0-9_-]{1,128})\/analysis$/.exec(route);
      if (analysisRoute && request.method === "POST") {
        send(response, 202, await createJob(db, uid, "CASE", {caseId: analysisRoute[1]})); return;
      }
      const sealRoute = /^\/api\/cases\/([A-Za-z0-9_-]{1,128})\/seal$/.exec(route);
      if (sealRoute && request.method === "POST") {
        // No body is read. The head that gets signed is computed from the store, never sent,
        // so there is nothing a caller could put in one but a digest of their choosing.
        send(response, 200, await sealCase(db, uid, {caseId: sealRoute[1]}, sealKey)); return;
      }
      const evidenceRoute = /^\/api\/cases\/([A-Za-z0-9_-]{1,128})\/evidence\/([A-Za-z0-9_-]{1,128})\/(file|process)$/.exec(route);
      if (evidenceRoute) {
        const [, caseId, evidenceId, operation] = evidenceRoute;
        const caseDoc = await db.collection("cases").doc(caseId).get();
        assertOwner(caseDoc, uid);
        const evidenceRef = db.collection("evidence").doc(evidenceId);
        const evidenceDoc = await evidenceRef.get();
        assertOwner(evidenceDoc, uid, caseId);
        const evidence = evidenceDoc.data();
        if (operation === "process" && request.method === "POST") {
          send(response, 202, await createJob(db, uid, "EVIDENCE", {caseId, evidenceId})); return;
        }
        if (operation === "file" && request.method === "GET") {
          if (!evidence.storagePath) throw problem("not-found", "No original file has been uploaded for this evidence.");
          const [bytes] = await bucket.file(evidence.storagePath).download();
          response.writeHead(200, {"Content-Type": evidence.mimeType || "application/octet-stream", "Content-Length": bytes.length, "Content-Disposition": "attachment", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"});
          response.end(bytes); return;
        }
        if (operation === "file" && request.method === "PUT") {
          if (evidence.kind === "NOTE") throw problem("invalid-argument", "Typed notes do not have original files.");
          const mime = String(request.headers["content-type"] || "application/octet-stream").split(";")[0];
          if (!MIME_TYPES.test(mime)) throw problem("invalid-argument", "This content type cannot be stored as evidence.");
          if (Number(request.headers["content-length"]) > MAX_FILE) throw problem("file-limit", "Files must be 100 MB or smaller.");
          const extension = /\.([a-z0-9]{1,12})$/i.exec(evidence.fileName || "")?.[1]?.toLowerCase() || "bin";
          const objectPath = `users/${uid}/cases/${caseId}/${evidenceId}/original.${extension}`;
          const destination = safePath(originals, objectPath);
          await fs.mkdir(path.dirname(destination), {recursive: true, mode: 0o700});
          const temporary = `${destination}.${randomUUID()}.upload`;
          let size = 0;
          const hash = createHash("sha256");
          const handle = await fs.open(temporary, "wx", 0o600);
          try {
            for await (const chunk of request) {
              size += chunk.length;
              if (size > MAX_FILE) throw problem("file-limit", "Files must be 100 MB or smaller.");
              hash.update(chunk); await handle.write(chunk);
            }
            if (!size) throw problem("invalid-argument", "The file is empty.");
            const sha256 = hash.digest("hex");
            await handle.close();
            await db.runTransaction(async (transaction) => {
              const current = await transaction.get(evidenceRef);
              assertOwner(current, uid, caseId);
              if (current.data().storagePath) {
                if (current.data().sha256 !== sha256) throw problem("failed-precondition", "An original is already stored. Add changed content as a new evidence item.");
                return;
              }
              const usedBytes = Object.values(db.data.files || {}).filter((item) => item.ownerId === uid).reduce((total, item) => total + item.size, 0);
              const storageLimit = 2 * 1024 * 1024 * 1024;
              if (usedBytes + size > storageLimit) throw problem("resource-exhausted", "Your account has reached its 2 GB original-file limit. Contact the platform operator to manage retention.");
              await fs.rename(temporary, destination);
              transaction.set(db.collection("files").doc(objectPath), {ownerId: uid, size, contentType: mime});
              transaction.update(evidenceRef, {storagePath: objectPath, sha256, mimeType: mime, sizeBytes: size, state: "QUEUED", updatedAt: Date.now(), failureReason: null});
            });
            const receipt = await enqueueEvidence(uid, caseId, evidenceId);
            send(response, 201, {storagePath: objectPath, sha256, sizeBytes: size, ...receipt});
          } catch (error) {
            const current = await evidenceRef.get();
            if (current.exists && !current.data().storagePath) await evidenceRef.update({state: "FAILED", failureReason: "The upload was interrupted. Select the original file again to retry.", updatedAt: Date.now()});
            throw error;
          } finally {
            await handle.close().catch(() => {});
            await fs.unlink(temporary).catch(() => {});
          }
          return;
        }
      }
      throw problem("not-found", "This endpoint does not exist.");
    } catch (error) {
      const code = STATUS[error.code] ? error.code : "internal";
      if (!response.headersSent) send(response, STATUS[code] || 500, {code, error: code === "internal" ? "The request could not be completed. Try again." : error.message});
      else response.end();
    }
  });
  server.requestTimeout = 300000;
  server.maxConnections = 40;
  let running = false;
  const worker = setInterval(async () => {
    if (running) return;
    await db.tail;
    // Recover the narrow window between committing intake/upload metadata and enqueueing.
    const jobs = Object.values(db.data.processingJobs || {});
    const unqueued = Object.values(db.data.evidence || {}).find((item) => item.state === "QUEUED" && !item.deletedAt && (item.kind === "NOTE" || item.storagePath) && !jobs.some((job) => job.evidenceId === item.id && ["QUEUED", "PROCESSING"].includes(job.state)));
    if (unqueued) {
      running = true;
      try { await enqueueEvidence(unqueued.ownerId, unqueued.caseId, unqueued.id); } finally { running = false; }
      return;
    }
    const interrupted = Object.values(db.data.evidence || {}).find((item) => item.state === "UPLOADING" && item.updatedAt < Date.now() - 600000);
    if (interrupted) {
      await db.collection("evidence").doc(interrupted.id).update({state: "FAILED", failureReason: "The upload was interrupted. Select the original file again to retry.", updatedAt: Date.now()});
    }
    const next = Object.values(db.data.processingJobs || {}).sort((a, b) => a.createdAt - b.createdAt).find((item) => item.state === "QUEUED" || (item.state === "PROCESSING" && item.updatedAt < Date.now() - 600000));
    if (!next) return;
    running = true;
    try { await processJob({db, bucket, apiKey}, next.id); } catch { /* Durable queue retries an expired processing lease. */ } finally { running = false; }
  }, 500);
  worker.unref();
  server.on("close", () => clearInterval(worker));
  return {server, db};
}

if (require.main === module) {
  try { process.loadEnvFile(path.join(__dirname, ".env.local")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const host = process.env.API_HOST || "127.0.0.1";
  if (process.env.FIREBASE_AUTH_EMULATOR_HOST && !["127.0.0.1", "localhost", "::1"].includes(host)) throw new Error("Auth emulator mode must bind to loopback only.");
  createLocalServer({directory: process.env.DATA_DIRECTORY, apiKey: process.env.GROQ_API_KEY, sealKey: process.env.CRUCIBLE_SEAL_KEY, projectId: process.env.FIREBASE_PROJECT_ID || "d-dectect", origins: (process.env.WEB_ORIGINS || "").split(",").filter(Boolean)})
    .then(({server}) => server.listen(Number(process.env.PORT || 8787), host, () => { process.stdout.write(`Evidence backend listening on ${host}:${process.env.PORT || 8787}; private persistent storage active.\n`); }))
    .catch(() => { process.stderr.write("Evidence backend could not start. Check the storage directory and server configuration.\n"); process.exitCode = 1; });
}
module.exports = {createLocalServer, safePath};
