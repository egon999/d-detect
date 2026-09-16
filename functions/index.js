"use strict";
const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {onDocumentCreated} = require("firebase-functions/v2/firestore");
const {defineSecret} = require("firebase-functions/params");
const {initializeApp} = require("firebase-admin/app");
const {getFirestore} = require("firebase-admin/firestore");
const {getStorage} = require("firebase-admin/storage");
const {createJob, processJob} = require("./src/jobs");
const {sealCase} = require("./src/seal");

initializeApp();
const providerKey = defineSecret("GROQ_API_KEY");
const sealKey = defineSecret("CRUCIBLE_SEAL_KEY");
const options = {region: "us-central1", maxInstances: 8, timeoutSeconds: 60};
const SAFE_CODES = ["invalid-argument", "permission-denied", "not-found", "failed-precondition", "resource-exhausted"];

function request(type) {
  return onCall(options, async (call) => {
    if (!call.auth) throw new HttpsError("unauthenticated", "Sign in to process evidence.");
    try {
      return await createJob(getFirestore(), call.auth.uid, type, call.data);
    } catch (error) {
      if (error.code && SAFE_CODES.includes(error.code)) {
        throw new HttpsError(error.code, error.message);
      }
      throw new HttpsError("internal", "The processing request could not be saved. Try again.");
    }
  });
}
exports.requestEvidenceProcessing = request("EVIDENCE");
exports.requestCaseAnalysis = request("CASE");

/**
 * Signs a case's audit chain.
 *
 * Has the signing key, so it is the narrowest function in this file: one document read, one
 * chain build, one signature. `maxInstances` is low and deliberately so — a caller who can
 * make this run a thousand times cannot forge anything (the head is read from Firestore, not
 * supplied), but they can spend the project's budget, and nothing legitimate seals a case in
 * a loop.
 */
exports.sealCase = onCall({...options, maxInstances: 4, secrets: [sealKey]}, async (call) => {
  if (!call.auth) throw new HttpsError("unauthenticated", "Sign in to seal a record.");
  try {
    return await sealCase(getFirestore(), call.auth.uid, call.data, sealKey.value());
  } catch (error) {
    if (error.code && SAFE_CODES.includes(error.code)) throw new HttpsError(error.code, error.message);
    throw new HttpsError("internal", "The record could not be sealed. Try again.");
  }
});

exports.processEvidenceJob = onDocumentCreated({
  document: "processingJobs/{jobId}", region: "us-central1", timeoutSeconds: 540,
  memory: "1GiB", maxInstances: 8, concurrency: 1, retry: true, secrets: [providerKey],
}, async (event) => {
  if (!event.data) return;
  await processJob({db: getFirestore(), bucket: getStorage().bucket(), apiKey: providerKey.value()}, event.params.jobId);
});
