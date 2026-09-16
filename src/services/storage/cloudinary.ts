/**
 * Cloudinary: the optional off-device copy.
 *
 * ## What this is for, and what it is not
 *
 * `./evidence-storage.ts` is the source of truth — originals live in the app's private
 * directory on the device. That covers everything the product needs to do, offline, with no
 * account provisioning and no billing plan. It has exactly one weakness: uninstall the app or
 * lose the phone and the files are gone.
 *
 * This module is the answer to that, and only that. A successful mirror means a second copy
 * exists; a failed mirror means there is still one copy and the case is unaffected. **A mirror
 * failure must never fail an evidence record.** Anything that treats this as the primary path
 * reintroduces the problem the local store was built to solve.
 *
 * ## Unsigned uploads, and the secret that is not here
 *
 * Uploads are unsigned: the request carries a cloud name and a preset name, both public by
 * nature — the cloud name appears in every delivery URL and the preset name only points at a
 * policy configured server-side.
 *
 * The API secret is **not** in this file, not in `.env`, and not in the bundle. Signing an
 * upload requires it, and any value reachable from client code is a published value: an
 * `EXPO_PUBLIC_` variable is inlined into the JavaScript bundle at build time, so `unzip` on
 * the APK and `grep` for the prefix recovers it. That secret authorises deleting assets and
 * enumerating the entire account through the Admin API, so it can only ever live on a server —
 * and this project has no server. Hence unsigned, with the restrictions applied to the preset
 * in the console instead: single folder, size cap, allowed formats, `access_mode: authenticated`.
 *
 * `npm run setup:cloudinary` configures that preset. It takes the `cloudinary://key:secret@cloud`
 * string, talks to the Admin API from Node, and writes back only the two public values.
 *
 * ## Delivery is authenticated, so a URL is not a public link
 *
 * The preset sets `access_mode: authenticated`, which means the returned URL does not resolve
 * without a signature. That is deliberate: a receipt or a salary slip must not become a
 * guessable public link, and Cloudinary's default `upload` access mode would make it one.
 */

import { scrubKey } from '../ai/groq-client';

/** Same ceiling as the local store, for the reason documented there (Groq's Whisper limit). */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/**
 * Milliseconds before an upload is abandoned.
 *
 * A 100 MB video over a weak mobile connection can legitimately take minutes, and killing it
 * at 30 seconds would make the mirror useless exactly where it matters most. This is a
 * background copy, so a long timeout costs the user nothing.
 */
const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;

export interface CloudinaryConfig {
  cloudName: string;
  uploadPreset: string;
  /** True when both values are present, i.e. an upload can at least be attempted. */
  isConfigured: boolean;
}

export type UploadFailureReason =
  /** No cloud name or preset compiled into the build. The default state, not an error. */
  | 'NOT_CONFIGURED'
  /** Larger than `MAX_UPLOAD_BYTES` before we even tried. */
  | 'TOO_LARGE'
  /** Request never reached Cloudinary — aeroplane mode, captive portal, DNS. */
  | 'NETWORK'
  /** Cloudinary answered and refused: wrong preset, disallowed format, quota. */
  | 'REJECTED'
  /** The caller aborted it, or it ran past `UPLOAD_TIMEOUT_MS`. */
  | 'CANCELLED';

export type CloudinaryUploadResult =
  | {
      ok: true;
      /** Delivery URL. Requires a signature to resolve — see the note on access mode above. */
      url: string;
      publicId: string;
      /** Cloudinary's own classification, needed to build a correct delivery URL later. */
      resourceType: string;
      format: string | null;
      bytes: number | null;
    }
  | {
      ok: false;
      reason: UploadFailureReason;
      /** Shown to the user as-is, so it is written for one. */
      message: string;
      /** HTTP status where there was one. Absent for network failure and cancellation. */
      status?: number;
      /** True when trying the identical upload again could plausibly succeed. */
      retryable: boolean;
    };

export interface UploadOptions {
  uri: string;
  name: string;
  mimeType: string;
  /** Known size in bytes, when the picker reported one. Skips the pre-flight guard if null. */
  sizeBytes?: number | null;
  /** Folder within the preset's configured root. Keeps one user's evidence together. */
  folder?: string;
  /** 0..1. Fires on real byte progress, so a stalled upload visibly stalls. */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

/**
 * Reads the two public values out of the build.
 *
 * Both are read at call time rather than cached at module load, because Expo replaces
 * `process.env.EXPO_PUBLIC_*` at build time and a test may want to observe an unconfigured
 * build without reloading the module graph.
 */
export function getCloudinaryConfig(): CloudinaryConfig {
  const cloudName = (process.env.EXPO_PUBLIC_CLOUDINARY_CLOUD_NAME ?? '').trim();
  const uploadPreset = (process.env.EXPO_PUBLIC_CLOUDINARY_UPLOAD_PRESET ?? '').trim();
  return { cloudName, uploadPreset, isConfigured: cloudName.length > 0 && uploadPreset.length > 0 };
}

/** Back-compat exports. Prefer `getCloudinaryConfig()`, which is honest about the empty case. */
export const CLOUDINARY_CLOUD_NAME = (process.env.EXPO_PUBLIC_CLOUDINARY_CLOUD_NAME ?? '').trim();
export const CLOUDINARY_UPLOAD_PRESET = (process.env.EXPO_PUBLIC_CLOUDINARY_UPLOAD_PRESET ?? '').trim();

/**
 * Which Cloudinary endpoint a file belongs on.
 *
 * Cloudinary refuses a video posted to `/image/upload`, and `auto` is not accepted on the
 * unsigned endpoint for every account tier, so the resource type is chosen here from the mime
 * type. `raw` is the catch-all for PDFs, spreadsheets and email files: Cloudinary would
 * otherwise try to rasterise them, which both costs transformation credits and can fail on a
 * password-protected PDF.
 */
function resourceTypeFor(mimeType: string, name: string): 'image' | 'video' | 'raw' {
  const mime = mimeType.toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  // Audio goes to the video endpoint. That is Cloudinary's own model, not a workaround:
  // it treats audio as video without a visual track.
  if (mime.startsWith('video/') || mime.startsWith('audio/')) return 'video';
  if (mime.length > 0) return 'raw';
  const extension = /\.([a-z0-9]{1,12})$/i.exec(name)?.[1]?.toLowerCase() ?? '';
  if (['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'gif', 'bmp', 'tif', 'tiff'].includes(extension)) return 'image';
  if (['mp4', 'mov', 'mkv', 'webm', 'avi', '3gp', 'm4v', 'mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'].includes(extension))
    return 'video';
  return 'raw';
}

function failure(
  reason: UploadFailureReason,
  message: string,
  retryable: boolean,
  status?: number,
): CloudinaryUploadResult {
  return { ok: false, reason, message, retryable, ...(status === undefined ? {} : { status }) };
}

/**
 * Sends one file to Cloudinary as an unsigned upload.
 *
 * `XMLHttpRequest` rather than `fetch`, for one reason: `fetch` has no upload progress event
 * in React Native or in any browser without streams, and a multi-minute video upload with no
 * progress is indistinguishable from a hang. That is the whole reason this is not a `fetch`
 * call like the rest of the codebase.
 *
 * Never throws. The caller is a background mirror; a rejected promise there would surface as
 * an unhandled rejection rather than as anything a user could act on.
 */
export async function uploadToCloudinary(options: UploadOptions): Promise<CloudinaryUploadResult> {
  const config = getCloudinaryConfig();
  if (!config.isConfigured) {
    return failure(
      'NOT_CONFIGURED',
      'Cloud backup is not set up for this build. Files are stored on this device only.',
      false,
    );
  }
  if ((options.sizeBytes ?? 0) > MAX_UPLOAD_BYTES) {
    return failure('TOO_LARGE', 'This file is over the 100 MB limit for cloud backup.', false);
  }
  if (options.signal?.aborted) return failure('CANCELLED', 'Cloud backup cancelled.', true);

  const resourceType = resourceTypeFor(options.mimeType, options.name);
  const endpoint = `https://api.cloudinary.com/v1_1/${encodeURIComponent(config.cloudName)}/${resourceType}/upload`;

  const form = new FormData();
  form.append('upload_preset', config.uploadPreset);
  if (options.folder) form.append('folder', options.folder);
  // React Native's FormData takes this shape for a file part and streams it from disk. Reading
  // the file into memory first would double peak memory on a 100 MB video for no benefit.
  form.append('file', { uri: options.uri, name: options.name, type: options.mimeType } as unknown as Blob);

  return await new Promise<CloudinaryUploadResult>((resolve) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    /** Resolves exactly once. XHR can fire both `onerror` and `onabort` for one failure. */
    const settle = (result: CloudinaryUploadResult) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', cancel);
      resolve(result);
    };
    const cancel = () => xhr.abort();

    xhr.open('POST', endpoint);
    xhr.timeout = UPLOAD_TIMEOUT_MS;
    // Content-Type is deliberately not set: the runtime has to add the multipart boundary.
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) options.onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        // Cloudinary's own words are useful here — "Upload preset not found" tells the
        // developer exactly what to fix — but they are scrubbed first, because an error body
        // can echo request parameters.
        let detail = '';
        try {
          detail = String((JSON.parse(xhr.responseText) as { error?: { message?: string } }).error?.message ?? '');
        } catch {
          // Non-JSON body, e.g. an HTML error page from a proxy. The status alone will do.
        }
        return settle(
          failure(
            'REJECTED',
            detail ? `Cloud backup was refused: ${scrubKey(detail)}` : 'Cloud backup was refused by the server.',
            // 5xx is worth another attempt; a 4xx means the preset or the file is wrong and
            // an identical retry will be refused identically.
            xhr.status >= 500,
            xhr.status,
          ),
        );
      }
      try {
        const body = JSON.parse(xhr.responseText) as {
          secure_url?: string;
          public_id?: string;
          resource_type?: string;
          format?: string;
          bytes?: number;
        };
        if (!body.secure_url || !body.public_id) {
          return settle(failure('REJECTED', 'Cloud backup did not confirm the file was stored.', true, xhr.status));
        }
        return settle({
          ok: true,
          url: body.secure_url,
          publicId: body.public_id,
          resourceType: body.resource_type ?? resourceType,
          format: body.format ?? null,
          bytes: typeof body.bytes === 'number' ? body.bytes : null,
        });
      } catch {
        return settle(failure('REJECTED', 'Cloud backup returned a response this app could not read.', true, xhr.status));
      }
    };
    xhr.onerror = () =>
      settle(failure('NETWORK', 'Could not reach cloud backup. The file is still stored on this device.', true));
    xhr.ontimeout = () => settle(failure('NETWORK', 'Cloud backup timed out. The file is still stored on this device.', true));
    xhr.onabort = () => settle(failure('CANCELLED', 'Cloud backup cancelled.', true));

    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) {
      xhr.abort();
      return;
    }
    xhr.send(form);
  });
}

/**
 * Mirrors a stored original off-device, if a mirror is configured.
 *
 * Deliberately swallows every failure into a `CloudinaryUploadResult` the caller may ignore.
 * The local copy already exists by the time this runs; a network problem here is not an
 * evidence problem, and surfacing it as one would teach the user to distrust a case that is
 * in fact complete.
 */
export async function mirrorToCloud(options: UploadOptions): Promise<CloudinaryUploadResult> {
  try {
    return await uploadToCloudinary(options);
  } catch {
    return failure('NETWORK', 'Cloud backup could not run. The file is still stored on this device.', true);
  }
}
