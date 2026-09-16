"use strict";
const {spawn} = require("node:child_process");
const path = require("node:path");
const {problem} = require("./contracts");

function parseDocument(bytes, kind) {
  return new Promise((resolve, reject) => {
    // The parser receives no provider key, Firebase identity, or other server credentials.
    const environment = Object.fromEntries(["PATH", "SystemRoot", "TEMP", "TMP", "WINDIR"].filter((name) => process.env[name]).map((name) => [name, process.env[name]]));
    const child = spawn(process.execPath, ["--max-old-space-size=256", path.join(__dirname, "parser-worker.js"), kind], {stdio: ["pipe", "pipe", "ignore"], windowsHide: true, env: environment});
    let settled = false;
    let size = 0;
    const output = [];
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) { child.kill(); reject(error); } else resolve(result);
    };
    const timer = setTimeout(() => finish(problem("document-timeout", "This document exceeded the 30-second processing limit. Split it into smaller documents.")), 30000);
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) finish(problem("document-limit", "This document produced too much extracted content."));
      else output.push(chunk);
    });
    child.on("error", () => finish(problem("document-unavailable", "The document processor could not start.")));
    child.stdin.on("error", () => {});
    child.on("close", (code) => {
      if (code !== 0) return finish(problem("invalid-file", "This document could not be read safely. It may be damaged, encrypted, or too complex."));
      try { finish(null, JSON.parse(Buffer.concat(output).toString("utf8"))); } catch { finish(problem("invalid-file", "The document processor returned unreadable content.")); }
    });
    child.stdin.end(bytes);
  });
}
module.exports = {parseDocument};
