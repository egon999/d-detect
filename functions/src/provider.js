"use strict";
const {problem} = require("./contracts");
const ENDPOINT = "https://api.groq.com/openai/v1";
async function providerFetch(path, options, fetchImpl = fetch) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let response;
    try { response = await fetchImpl(`${ENDPOINT}${path}`, {...options, signal: AbortSignal.timeout(90000)}); } catch {
      if (attempt < 2) continue;
      throw problem("provider-unavailable", "The analysis service could not be reached. Retry processing.");
    }
    if (response.ok) return response.json();
    if ((response.status === 429 || response.status >= 500) && attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 700 * (attempt + 1))); continue;
    }
    if (response.status === 401 || response.status === 403) throw problem("provider-configuration", "The platform analysis service needs administrator attention.");
    if (response.status === 429) throw problem("provider-busy", "The analysis service is busy. Retry shortly.");
    throw problem("provider-rejected", "The analysis service could not process this content.");
  }
}
function requireKey(key) { if (!key) throw problem("provider-configuration", "The platform analysis service has not been configured."); }
async function jsonCompletion(apiKey, system, user, {vision = false, fetchImpl} = {}) {
  requireKey(apiKey);
  const model = vision ? (process.env.GROQ_VISION_MODEL || "qwen/qwen3.8-27b") : (process.env.GROQ_TEXT_MODEL || "openai/gpt-oss-120b");
  const result = await providerFetch("/chat/completions", {
    method: "POST", headers: {Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json"},
    body: JSON.stringify({model, temperature: 0, max_completion_tokens: 16000, response_format: {type: "json_object"}, messages: [{role: "system", content: system}, {role: "user", content: user}]}),
  }, fetchImpl);
  const choice = result.choices?.[0];
  if (choice?.finish_reason === "length") throw problem("context-limit", "The analysis exceeded its response limit. Split this evidence set into smaller cases.");
  try { return {model, data: JSON.parse(choice.message.content)}; } catch {
    throw problem("invalid-response", "The analysis service returned an unreadable result. Retry processing.");
  }
}
async function transcribe(apiKey, bytes, name, mimeType) {
  requireKey(apiKey);
  if (bytes.length > 25 * 1024 * 1024) throw problem("media-limit", "Audio transcription currently accepts files up to 25 MB. Upload shorter segments.");
  const form = new FormData();
  form.append("file", new Blob([bytes], {type: mimeType}), name);
  form.append("model", "whisper-large-v3"); form.append("response_format", "verbose_json"); form.append("timestamp_granularities[]", "segment");
  return providerFetch("/audio/transcriptions", {method: "POST", headers: {Authorization: `Bearer ${apiKey}`}, body: form});
}
module.exports = {providerFetch, jsonCompletion, transcribe};
