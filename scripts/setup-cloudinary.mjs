/**
 * One-command Cloudinary setup.
 *
 * ## What it does
 *
 *   node scripts/setup-cloudinary.mjs "cloudinary://<api_key>:<api_secret>@<cloud_name>"
 *
 * 1. Verifies the credentials actually authenticate, and says which part is wrong if not.
 * 2. Creates (or updates) an **unsigned** upload preset locked down to this app's needs.
 * 3. Writes the two public values into `.env`.
 *
 * The `cloudinary://...` string is what the Cloudinary console shows under
 * Settings -> API Keys as "API environment variable" — one copy, one paste. It is accepted
 * here instead of three separate flags because the cloud name is the piece people cannot
 * find, and it is already inside that string.
 *
 * ## Why unsigned, and what is not written anywhere
 *
 * The API secret is used by this script, on a developer machine, and is never written to
 * `.env`, never printed, and never reaches the app. It authorises deleting every asset in
 * the account and reading the whole Admin API, so a copy inside an APK is a published
 * credential — `unzip` and `grep` is the whole attack. The app uploads against an unsigned
 * preset instead: the only thing compiled into the build is a cloud name (which appears in
 * every delivery URL anyway) and a preset name (which is a pointer to a policy that lives
 * server-side, where the caller cannot change it).
 *
 * That policy is the security boundary, which is why the preset created here is restricted
 * rather than left at Cloudinary's permissive defaults.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PRESET_NAME = 'ddetect_evidence';
const ENV_PATH = resolve(process.cwd(), '.env');

/**
 * The preset's policy.
 *
 * `unsigned: true` is the point of the exercise. Everything else narrows what an unsigned
 * caller is allowed to do with it, because an unsigned preset is, by definition, usable by
 * anyone who reads the app bundle:
 *
 * - `folder` confines every upload to one prefix, so a stray upload cannot land on top of
 *   something else in the account.
 * - `allowed_formats` rejects anything that is not a document or an image. Without it the
 *   preset accepts video and raw archives, and the free tier's storage disappears into the
 *   first person who notices.
 * - `access_mode: 'authenticated'` means a delivery URL alone does not fetch the asset;
 *   this is evidence, and evidence a URL guess can reach is not private.
 * - `unique_filename` + `use_filename: false` stops a caller from choosing the public id,
 *   which is how one upload overwrites another.
 * - `invalidate` so a replaced asset does not keep serving from the CDN edge.
 */
const PRESET = {
  unsigned: true,
  folder: 'ddetect/evidence',
  access_mode: 'authenticated',
  resource_type: 'auto',
  allowed_formats: 'jpg,jpeg,png,webp,heic,heif,gif,bmp,tiff,pdf,txt,csv',
  use_filename: false,
  unique_filename: true,
  overwrite: false,
  invalidate: true,
};

function parseCloudinaryUrl(raw) {
  const match = /^cloudinary:\/\/([^:]+):([^@]+)@(.+)$/.exec(raw.trim());
  if (!match) {
    throw new Error(
      'Expected a string of the form cloudinary://<api_key>:<api_secret>@<cloud_name>.\n' +
        'Cloudinary console -> Settings -> API Keys -> "API environment variable".',
    );
  }
  const [, apiKey, apiSecret, cloudName] = match;
  return { apiKey, apiSecret, cloudName };
}

function authHeader({ apiKey, apiSecret }) {
  return `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString('base64')}`;
}

async function adminRequest(creds, path, init = {}) {
  const response = await fetch(`https://api.cloudinary.com/v1_1/${creds.cloudName}${path}`, {
    ...init,
    headers: { Authorization: authHeader(creds), ...(init.headers ?? {}) },
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  return { status: response.status, ok: response.ok, body };
}

/**
 * Confirms the credentials before anything is created.
 *
 * Cloudinary distinguishes the three ways this can be wrong in its error message, so the
 * failure tells the user which value to go back and re-copy instead of "401".
 */
async function verify(creds) {
  const { status, ok, body } = await adminRequest(creds, '/ping');
  if (ok) return;

  const message = body?.error?.message ?? `HTTP ${status}`;
  if (/cloud_name mismatch/i.test(message)) {
    throw new Error(
      `The API key is valid, but it does not belong to the cloud "${creds.cloudName}".\n` +
        'Re-copy the whole cloudinary:// string — the part after the @ is the cloud name.',
    );
  }
  if (/api_secret mismatch/i.test(message)) {
    throw new Error('The API secret is wrong. Re-copy it from the console, or rotate it and copy the new one.');
  }
  if (/api_key/i.test(message)) {
    throw new Error(`Cloudinary rejected the API key: ${message}`);
  }
  throw new Error(`Cloudinary rejected the credentials: ${message}`);
}

/** Creates the preset, or updates it in place when a previous run already made it. */
async function upsertPreset(creds) {
  const form = new URLSearchParams({ name: PRESET_NAME });
  for (const [key, value] of Object.entries(PRESET)) form.set(key, String(value));

  const created = await adminRequest(creds, '/upload_presets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  if (created.ok) return 'created';

  const message = created.body?.error?.message ?? '';
  if (!/already exists/i.test(message)) {
    throw new Error(`Could not create the upload preset: ${message || `HTTP ${created.status}`}`);
  }

  const updateForm = new URLSearchParams();
  for (const [key, value] of Object.entries(PRESET)) updateForm.set(key, String(value));
  const updated = await adminRequest(creds, `/upload_presets/${PRESET_NAME}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: updateForm,
  });
  if (!updated.ok) {
    throw new Error(
      `The preset exists but could not be updated: ${updated.body?.error?.message ?? `HTTP ${updated.status}`}`,
    );
  }
  return 'updated';
}

/**
 * Rewrites the two Cloudinary lines in `.env` and leaves every other line untouched,
 * comments included. Rewriting the file from a template would delete the explanations of
 * why the secrets are absent, which are the only thing stopping someone putting them back.
 */
function writeEnv(cloudName) {
  const contents = readFileSync(ENV_PATH, 'utf8');
  const next = contents
    .replace(/^EXPO_PUBLIC_CLOUDINARY_CLOUD_NAME=.*$/m, `EXPO_PUBLIC_CLOUDINARY_CLOUD_NAME=${cloudName}`)
    .replace(/^EXPO_PUBLIC_CLOUDINARY_UPLOAD_PRESET=.*$/m, `EXPO_PUBLIC_CLOUDINARY_UPLOAD_PRESET=${PRESET_NAME}`);

  if (next === contents) {
    throw new Error(
      'Could not find the EXPO_PUBLIC_CLOUDINARY_ lines in .env. Add them and run this again:\n' +
        `  EXPO_PUBLIC_CLOUDINARY_CLOUD_NAME=${cloudName}\n` +
        `  EXPO_PUBLIC_CLOUDINARY_UPLOAD_PRESET=${PRESET_NAME}`,
    );
  }
  writeFileSync(ENV_PATH, next);
}

async function main() {
  const argument = process.argv[2] ?? process.env.CLOUDINARY_URL;
  if (!argument) {
    console.error(
      'Usage:\n  node scripts/setup-cloudinary.mjs "cloudinary://<api_key>:<api_secret>@<cloud_name>"\n\n' +
        'Copy that string from the Cloudinary console: Settings -> API Keys -> "API environment variable".',
    );
    process.exit(2);
  }

  const creds = parseCloudinaryUrl(argument);
  process.stdout.write(`Checking credentials for cloud "${creds.cloudName}"... `);
  await verify(creds);
  console.log('ok');

  process.stdout.write(`Configuring unsigned preset "${PRESET_NAME}"... `);
  const outcome = await upsertPreset(creds);
  console.log(outcome);

  writeEnv(creds.cloudName);
  console.log(`Wrote EXPO_PUBLIC_CLOUDINARY_CLOUD_NAME and EXPO_PUBLIC_CLOUDINARY_UPLOAD_PRESET to .env`);
  console.log('\nThe API secret was not written anywhere. Rebuild the app to pick up the new values.');
}

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
