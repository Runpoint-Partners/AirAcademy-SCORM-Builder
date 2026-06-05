#!/usr/bin/env node
'use strict';

/**
 * media-resolver.js — Build-time media resolution for Ascent course content.
 *
 * Resolves all media URL patterns found in Ascent HTML content:
 *   1. Public Ascent media    → download, upload to S3, rewrite to presigned URL
 *      (relative paths AND absolute https://ascent.aerostudies.com/... URLs)
 *   2. Hash-based file URLs   → download via auth, upload to S3, rewrite to presigned URL
 *   3. Vzaar/Vimeo iframes    → resolve to working <video> element
 *
 * Exports a single async function:
 *   resolveMedia({ html, networkId, courseId, version, ascentCookies })
 *     → { html: rewrittenHtml, report: { resolved: [...], failed: [...] } }
 *
 * Also exports helpers for standalone use:
 *   loginToAscent(username, password) → cookie string
 *   downloadHashFile(url, cookies)    → { buffer, contentType, extension }
 *   uploadMediaToS3({ buffer, key, contentType }) → presigned URL
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { S3Client, PutObjectCommand, HeadObjectCommand, DeleteObjectCommand, ListObjectsV2Command, CopyObjectCommand } = require('@aws-sdk/client-s3');
const { NodeHttpHandler } = require('@smithy/node-http-handler');
const { execFile } = require('child_process');
require('dotenv').config();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ASCENT_BASE = 'https://ascent.aerostudies.com';

// Hosts a Vimeo video may be EMBEDDED on. Vimeo's embed whitelist checks the
// Referer against the embedding domain, so a video with NO unlock hash 403s unless
// the Referer matches (OP-580: vimeo_386784430). The platform host migrated
// ascent.aerostudies.com -> aircrewacademy.aerostudies.com (2026-05-28) and either
// may be in a given video's whitelist, so we try BOTH known hosts (plus ASCENT_URL
// if config names a newer one) rather than trust a single, possibly-stale env
// value. Adding a future host = one array entry. BUILD-TIME ONLY: used to FETCH the
// video so we can rehost it to in-house S3; the rendered course references S3 only.
const VIMEO_EMBED_REFERERS = Array.from(new Set(
  [
    'https://aircrewacademy.aerostudies.com',
    'https://ascent.aerostudies.com',
    process.env.ASCENT_URL,
  ]
    .filter((h) => typeof h === 'string' && h.length > 0)
    .map((h) => h.replace(/\/+$/, '') + '/'),
));

// Vimeo serves the embed playerConfig (with the HLS URL) ONLY to a browser-like
// User-Agent; the default 'AirAcademy-MediaResolver/1.0' gets a config-less page.
// Used ONLY for the Vimeo player fetch.
const VIMEO_PLAYER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const S3_BUCKET = process.env.S3_BUCKET || 'aaa-courses';
const AWS_REGION = process.env.AWS_REGION || 'us-east-2';
const S3_CONTENT_PREFIX = process.env.S3_CONTENT_PREFIX || 'courses';

/** Maximum parallel downloads/uploads at any time. */
const CONCURRENCY_LIMIT = Number.parseInt(process.env.MEDIA_RESOLVER_CONCURRENCY || '15', 10);

/** Direct S3 URL base (used instead of presigned URLs now that bucket policy allows public reads). */
const S3_DIRECT_BASE = `https://${S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com`;

/** HTTP request timeout in milliseconds. */
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.MEDIA_RESOLVER_HTTP_TIMEOUT_MS || '30000', 10);

/** S3 request timeout in milliseconds. Large training videos routinely exceed 30s. */
const S3_REQUEST_TIMEOUT_MS = Number.parseInt(process.env.MEDIA_RESOLVER_S3_TIMEOUT_MS || '120000', 10);

/** Retry budget for transient media/S3 operations. */
const MEDIA_RETRY_ATTEMPTS = Number.parseInt(process.env.MEDIA_RESOLVER_RETRY_ATTEMPTS || '3', 10);

/**
 * Map Content-Type headers to file extensions.
 * Used when the URL itself does not reveal an extension.
 */
const CONTENT_TYPE_TO_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/x-icon': '.ico',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/ogg': '.ogv',
  'video/quicktime': '.mov',
  'video/x-ms-wmv': '.wmv',
  'video/x-msvideo': '.avi',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/ogg': '.ogg',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'application/octet-stream': '.bin',
  'text/html': '.html',
  'text/css': '.css',
  'text/plain': '.txt',
};

// ---------------------------------------------------------------------------
// S3 client (lazy singleton)
// ---------------------------------------------------------------------------

let _s3Client = null;

/** Cache: ascentPath → presigned S3 URL (avoids re-downloading across pages). */
const _publicMediaCache = new Map();

/**
 * Pending download promises: normalizedPath → Promise<void>.
 * When multiple concurrent modules need the same media file, only the first
 * actually downloads it. Others await the same promise and then read from
 * _publicMediaCache once it resolves. Prevents redundant Ascent downloads.
 */
const _pendingDownloads = new Map();

/**
 * Cache: ascentPath → { buffer, contentType, extension }.
 * Caches raw reference file downloads (from downloadHashFile) across modules
 * so the same FAA/OSHA PDFs aren't re-downloaded from Ascent hundreds of times.
 */
const _referenceDownloadCache = new Map();

function getS3Client() {
  if (!_s3Client) {
    _s3Client = new S3Client({
      region: AWS_REGION,
      requestHandler: new NodeHttpHandler({
        connectionTimeout: 5_000,
        requestTimeout: S3_REQUEST_TIMEOUT_MS,
        throwOnRequestTimeout: true,
      }),
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });
  }
  return _s3Client;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function retryDelayMs(attempt) {
  return 750 * Math.pow(2, attempt);
}

function isRetryableHttpStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

function isRetryableError(err) {
  const name = String(err?.name || '');
  const message = String(err?.message || '').toLowerCase();
  return (
    name === 'AbortError' ||
    name === 'TimeoutError' ||
    name === 'NetworkingError' ||
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('econnreset') ||
    message.includes('socket') ||
    message.includes('throttl')
  );
}

async function withTransientRetries(label, fn, { attempts = MEDIA_RETRY_ATTEMPTS, shouldRetry = isRetryableError } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt >= attempts - 1 || !shouldRetry(err)) break;
      const waitMs = retryDelayMs(attempt);
      console.warn(`    [retry] ${label} failed (${err.message}); retry ${attempt + 2}/${attempts} in ${waitMs}ms`);
      await sleep(waitMs);
    }
  }
  throw lastError;
}

async function sendS3WithRetry(label, commandFactory) {
  return withTransientRetries(label, () => getS3Client().send(commandFactory()), {
    shouldRetry: (err) => {
      const status = err?.$metadata?.httpStatusCode;
      return isRetryableHttpStatus(status) || isRetryableError(err);
    },
  });
}

// ---------------------------------------------------------------------------
// Helper: filesystem media cache lookup
// ---------------------------------------------------------------------------

/**
 * Check if a media file exists in the local filesystem cache (MEDIA_CACHE_DIR).
 * The cache key is the SHA-256 hex digest of the URL string.
 * Returns the file buffer if found and non-empty, or null if not cached.
 *
 * This function only READS from the cache — it never writes. The precache
 * script is responsible for populating the cache directory.
 *
 * @param {string} url  The media URL (used as cache key via SHA-256)
 * @returns {Buffer|null}
 */
function readFromMediaCache(url) {
  const cacheDir = process.env.MEDIA_CACHE_DIR;
  if (!cacheDir) return null;

  const hash = crypto.createHash('sha256').update(url).digest('hex');
  const cachePath = path.join(cacheDir, hash);

  try {
    const stat = fs.statSync(cachePath);
    if (!stat.isFile() || stat.size === 0) return null;
    return fs.readFileSync(cachePath);
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helper: loginToAscent
// ---------------------------------------------------------------------------

/**
 * Authenticate to Ascent and return the session cookie string.
 *
 * POSTs form data to /user/login, follows the redirect, and captures
 * the Set-Cookie headers. Returns a semicolon-joined cookie string
 * suitable for the Cookie header.
 *
 * @param {string} username  Ascent login email
 * @param {string} password  Ascent login password
 * @returns {Promise<string>} Cookie string (e.g. "PHPSESSID=abc123; ci_session=xyz")
 */
async function loginToAscent(username, password) {
  if (!username || !password) {
    username = process.env.ASCENT_USERNAME;
    password = process.env.ASCENT_PASSWORD;
  }
  if (!username || !password) {
    throw new Error('Ascent credentials not provided and not found in environment');
  }

  const loginUrl = `${ASCENT_BASE}/user/login`;
  const formBody = new URLSearchParams({ username, password });

  // POST with redirect: 'manual' so we can capture Set-Cookie before the redirect
  const res = await fetch(loginUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'AirAcademy-MediaResolver/1.0',
    },
    body: formBody.toString(),
    redirect: 'manual',
  });

  // Collect all Set-Cookie headers
  const setCookies = res.headers.getSetCookie
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean);

  if (!setCookies.length) {
    throw new Error(`Ascent login failed — no cookies returned (HTTP ${res.status})`);
  }

  // Extract just the name=value part from each Set-Cookie (strip path, domain, etc.)
  const cookies = setCookies
    .map(c => c.split(';')[0].trim())
    .filter(Boolean)
    .join('; ');

  // If the response was a redirect (302/303), follow it with cookies to confirm session
  if (res.status >= 300 && res.status < 400) {
    const redirectUrl = res.headers.get('location');
    if (redirectUrl) {
      const followUrl = redirectUrl.startsWith('http')
        ? redirectUrl
        : `${ASCENT_BASE}${redirectUrl}`;
      const verifyRes = await fetch(followUrl, {
        method: 'GET',
        headers: { 'Cookie': cookies, 'User-Agent': 'AirAcademy-MediaResolver/1.0' },
        redirect: 'follow',
      });
      // Consume body to prevent leak
      await verifyRes.text().catch(() => {});
    }
  }

  return cookies;
}

// ---------------------------------------------------------------------------
// Helper: downloadHashFile
// ---------------------------------------------------------------------------

/**
 * Download a hash-based file from Ascent using authenticated cookies.
 *
 * Hash files at /files/{networkId}-{hexhash} return 403 without auth.
 *
 * @param {string} url       Full URL or path (e.g. "/files/668-abc123...")
 * @param {string} cookies   Ascent session cookies
 * @returns {Promise<{ buffer: Buffer, contentType: string, extension: string }>}
 */
async function downloadHashFile(url, cookies) {
  // Check filesystem cache before making any HTTP calls
  const cached = readFromMediaCache(url);
  if (cached) {
    const contentType = 'application/octet-stream';
    const extension = inferExtensionFromUrl(url) || '.bin';
    console.log(`    [media-cache] HIT ${url} (${cached.length} bytes)`);
    return { buffer: cached, contentType, extension };
  }

  if (!cookies) {
    throw new Error(`Cannot download hash file without Ascent cookies: ${url}`);
  }

  // Build list of URLs to try. For bare filenames (reference_file paths like
  // "/AC_120_91A.pdf"), Ascent redirects to the login page. The actual files
  // live under /files/reference_library/90/<filename>.
  const urlsToTry = [];
  const fullUrl = url.startsWith('http') ? url : `${ASCENT_BASE}${url}`;
  urlsToTry.push(fullUrl);

  // If the path looks like a bare filename (starts with / and has an extension),
  // also try the reference_library path
  if (!url.startsWith('http') && !url.startsWith('/files/') && url.match(/\.\w{2,4}$/)) {
    urlsToTry.push(`${ASCENT_BASE}/files/reference_library/90${url}`);
  }

  let lastError = null;

  for (const tryUrl of urlsToTry) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(tryUrl, {
        method: 'GET',
        headers: {
          'Cookie': cookies,
          'User-Agent': 'AirAcademy-MediaResolver/1.0',
        },
        signal: controller.signal,
        redirect: 'follow',
      });

      if (!res.ok) {
        clearTimeout(timer);
        lastError = new Error(`Download failed: HTTP ${res.status} ${res.statusText} for ${tryUrl}`);
        continue;
      }

      const arrayBuffer = await res.arrayBuffer();
      clearTimeout(timer);

      const buffer = Buffer.from(arrayBuffer);
      const contentType = (res.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim();

      // Detect login page redirect: Ascent returns 200 with text/html even when
      // the requested file is a PDF/image. Two detection strategies:
      //   1. If content-type is text/html but the original URL has a non-HTML
      //      extension (.pdf, .doc, .jpg, etc.), it's almost certainly the login page.
      //   2. Check for Ascent-specific markers in the HTML body (<app-root>,
      //      big-logo.png, /utilities/globals).
      if (contentType === 'text/html') {
        const expectedExt = inferExtensionFromUrl(url);
        const expectingNonHtml = expectedExt && expectedExt !== '.html' && expectedExt !== '.htm';

        if (expectingNonHtml) {
          lastError = new Error(`Got text/html instead of expected ${expectedExt} for ${tryUrl}`);
          continue;
        }

        // Even for URLs without an extension (hash-based), detect the Ascent
        // login/shell page by its distinctive markers.
        const head = buffer.toString('utf8', 0, Math.min(buffer.length, 2000)).toLowerCase();
        if (head.includes('<app-root>') || head.includes('big-logo.png') ||
            head.includes('/utilities/globals') || head.includes('session-activity.js')) {
          lastError = new Error(`Got Ascent login/shell page instead of file for ${tryUrl}`);
          continue;
        }
      }

      const extension = CONTENT_TYPE_TO_EXT[contentType] || inferExtensionFromUrl(url) || '.bin';
      return { buffer, contentType, extension };
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        lastError = new Error(`Download timed out after ${REQUEST_TIMEOUT_MS}ms: ${tryUrl}`);
      } else {
        lastError = err;
      }
    }
  }

  throw lastError || new Error(`All download attempts failed for ${url}`);
}

/**
 * Try to extract a file extension from the URL path.
 * Returns null if none found (common for hash URLs).
 */
function inferExtensionFromUrl(url) {
  const pathPart = url.split('?')[0];
  const lastDot = pathPart.lastIndexOf('.');
  const lastSlash = pathPart.lastIndexOf('/');
  if (lastDot > lastSlash && lastDot < pathPart.length - 1) {
    const ext = pathPart.substring(lastDot).toLowerCase();
    if (ext.length <= 5) return ext;
  }
  return null;
}

function isLegacyBrowserVideoExtension(ext) {
  return ['.wmv', '.mov', '.avi'].includes(String(ext || '').toLowerCase());
}

function replaceExtension(filePath, nextExt) {
  return String(filePath || '').replace(/\.[^/.?#]+$/i, nextExt);
}

function isShowVideoPath(urlPath) {
  return /\/content\/showVideo\/\d+/i.test(String(urlPath || ''));
}

async function transcodeVideoBufferToMp4(buffer, sourceExt) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aaa-video-'));
  const inputPath = path.join(tmpDir, `input${sourceExt || '.video'}`);
  const outputPath = path.join(tmpDir, 'output.mp4');

  try {
    fs.writeFileSync(inputPath, buffer);
    await new Promise((resolve, reject) => {
      execFile('ffmpeg', [
        '-y',
        '-hide_banner',
        '-loglevel', 'error',
        '-i', inputPath,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '23',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-movflags', '+faststart',
        outputPath,
      ], { timeout: 180_000 }, (error, _stdout, stderr) => {
        if (error) {
          reject(new Error((stderr && stderr.trim()) || error.message));
          return;
        }
        resolve();
      });
    });
    return fs.readFileSync(outputPath);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// Helper: downloadPublicFile
// ---------------------------------------------------------------------------

/**
 * Download a publicly accessible file from Ascent (no auth cookies needed).
 *
 * Used for files under /files/media_library/, /learning_object_library/,
 * /content/, and /media/ which are served without authentication.
 *
 * @param {string} url  Full URL (e.g. "https://ascent.aerostudies.com/files/media_library/90/foo.jpg")
 * @returns {Promise<{ buffer: Buffer, contentType: string }|null>}  File data, or null on failure
 */
async function downloadPublicFile(url) {
  // Check filesystem cache before making any HTTP calls
  const cached = readFromMediaCache(url);
  if (cached) {
    const contentType = 'application/octet-stream';
    console.log(`    [media-cache] HIT ${url} (${cached.length} bytes)`);
    return { buffer: cached, contentType };
  }

  try {
    return await withTransientRetries(`public download ${url}`, async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const res = await fetch(url, {
          method: 'GET',
          headers: { 'User-Agent': 'AirAcademy-MediaResolver/1.0' },
          signal: controller.signal,
          redirect: 'follow',
        });

        if (!res.ok) {
          const err = new Error(`HTTP ${res.status} for ${url}`);
          err.httpStatus = res.status;
          throw err;
        }

        const arrayBuffer = await res.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const contentType = (res.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim();

        return { buffer, contentType };
      } finally {
        clearTimeout(timer);
      }
    }, {
      shouldRetry: (err) => isRetryableHttpStatus(err.httpStatus) || isRetryableError(err),
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      console.warn(`    [public-media] Download timed out after ${REQUEST_TIMEOUT_MS}ms: ${url}`);
    } else if (err.httpStatus) {
      console.warn(`    [public-media] Download failed: HTTP ${err.httpStatus} for ${url}`);
    } else {
      console.warn(`    [public-media] Download error for ${url}: ${err.message}`);
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helper: uploadMediaToS3
// ---------------------------------------------------------------------------

/**
 * Upload a media file to S3. If the key already exists, skip the upload
 * (idempotency). Returns a direct S3 URL (bucket policy allows public reads
 * on courses/* and player/* prefixes).
 *
 * @param {Object} opts
 * @param {Buffer} opts.buffer      File content
 * @param {string} opts.key         Full S3 key (e.g. "courses/668/100007/v1/media/668-abc.jpg")
 * @param {string} opts.contentType MIME type
 * @returns {Promise<string>} Direct S3 URL
 */
function encodeS3KeyForUrl(key) {
  return String(key)
    .split('/')
    .map((segment) => encodeURIComponent(segment).replace(/'/g, '%27'))
    .join('/');
}

async function uploadMediaToS3({ buffer, key, contentType }) {
  // Check if object already exists (idempotency)
  const exists = await s3ObjectExists(key);

  if (!exists) {
    await sendS3WithRetry(`S3 PutObject ${key}`, () => new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    }));
  }

  // Return direct URL (bucket policy grants public read for courses/* and player/*)
  // Encode each path segment so special chars (spaces, etc.) are properly percent-encoded.
  // This ensures the URL works correctly when the S3 key contains spaces or other
  // characters that need encoding in URLs.
  const encodedKey = encodeS3KeyForUrl(key);
  return `${S3_DIRECT_BASE}/${encodedKey}`;
}

/**
 * Check if an S3 object exists via HeadObject.
 *
 * @param {string} key S3 key
 * @returns {Promise<boolean>}
 */
async function s3ObjectExists(key) {
  try {
    await sendS3WithRetry(`S3 HeadObject ${key}`, () => new HeadObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
    }));
    return true;
  } catch (err) {
    // NotFound (404) means it doesn't exist — anything else is a real error
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
      return false;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Concurrency limiter
// ---------------------------------------------------------------------------

/**
 * Run async tasks with a concurrency limit.
 *
 * @param {Array<() => Promise<T>>} tasks  Array of zero-arg async functions
 * @param {number} limit  Max concurrent tasks
 * @returns {Promise<T[]>} Results in original order
 */
async function runWithConcurrency(tasks, limit) {
  const results = new Array(tasks.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < tasks.length) {
      const idx = nextIndex++;
      results[idx] = await tasks[idx]();
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(limit, tasks.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Category 1: Public Ascent media → download to S3
// ---------------------------------------------------------------------------

/**
 * Find, download, and upload all public Ascent media to S3, rewriting
 * src/href attributes to presigned S3 URLs.
 *
 * Matches relative paths:
 *   src="/files/media_library/...", src="/learning_object_library/...",
 *   src="/content/...", src="/media/...", src="../../learning_object_library/..."
 *
 * Also matches absolute Ascent URLs:
 *   src="https://ascent.aerostudies.com/learning_object_library/..."
 *   src="https://ascent.aerostudies.com/files/media_library/..."
 *
 * Handles both src and href attributes.
 *
 * These are publicly accessible on ascent.aerostudies.com (no auth needed).
 * Downloads each file and serves it from S3 so the courses are self-contained.
 *
 * @param {string} html
 * @param {Object} opts
 * @param {string} opts.networkId
 * @param {string} opts.courseId
 * @param {string} opts.version
 * @returns {Promise<{ html: string, entries: Array }>}
 */
function publicAscentRelativePattern() {
  return /((?:src|href)\s*=\s*)(["'])((?:\.\.\/)*(?:\/)?(?:files\/media_library|learning_object_library|content|media)\/.*?)\2/gi;
}

function publicAscentAbsolutePattern() {
  return /((?:src|href)\s*=\s*)(["'])(https?:\/\/ascent\.aerostudies\.com\/(files\/media_library|learning_object_library|content|media)\/.*?)\2/gi;
}

async function resolvePublicAscentMedia(html, { networkId, courseId, version }) {
  const entries = [];

  // Match src or href attributes with relative paths to known Ascent directories.
  // Handles both absolute (/learning_object_library/...) and relative (../../learning_object_library/...) forms.
  // Excludes hash-based /files/{networkId}-{hash} patterns (handled separately).
  const relativePattern = publicAscentRelativePattern();

  // Match src or href attributes with fully-qualified absolute Ascent URLs.
  // Catches URLs like https://ascent.aerostudies.com/learning_object_library/...
  // Excludes hash-based /files/{networkId}-{hash} patterns (handled by resolveHashFiles).
  const absolutePattern = publicAscentAbsolutePattern();

  // Collect all matches first (we can't do async work inside .replace)
  const matches = [];
  let m;
  while ((m = relativePattern.exec(html)) !== null) {
    const rawPath = m[3];
    // Normalize: strip leading ../ sequences and ensure leading /
    const normalized = '/' + rawPath.replace(/^(?:\.\.\/)+/, '').replace(/^\//, '');
    if (isShowVideoPath(normalized)) continue;
    matches.push({
      fullMatch: m[0],
      attr: m[1],
      quote: m[2],
      rawPath,
      normalized,
      absoluteUrl: `${ASCENT_BASE}${normalized}`,
    });
  }

  // Collect absolute Ascent URL matches
  while ((m = absolutePattern.exec(html)) !== null) {
    const rawUrl = m[3];
    // Extract path portion from the absolute URL
    const urlPath = rawUrl.replace(/^https?:\/\/ascent\.aerostudies\.com/, '');
    const normalized = urlPath.startsWith('/') ? urlPath : '/' + urlPath;
    if (isShowVideoPath(normalized)) continue;

    // Skip if this normalized path was already captured by the relative pattern
    if (matches.some(existing => existing.normalized === normalized && existing.fullMatch === m[0])) {
      continue;
    }

    matches.push({
      fullMatch: m[0],
      attr: m[1],
      quote: m[2],
      rawPath: rawUrl,
      normalized,
      absoluteUrl: rawUrl,
    });
  }

  if (matches.length === 0) return { html, entries };

  // Deduplicate by normalized path — multiple tags may reference the same file
  const uniquePaths = [...new Set(matches.map(mt => mt.normalized))];

  // Build download + upload tasks for paths not yet in cache.
  // Uses _pendingDownloads to coalesce concurrent requests: if another module
  // is already downloading the same file, we await its promise instead of
  // starting a redundant download from Ascent.
  const tasks = uniquePaths
    .filter(p => !_publicMediaCache.has(p))
    .map(normalizedPath => async () => {
      // Check if another concurrent module is already downloading this path
      if (_pendingDownloads.has(normalizedPath)) {
        await _pendingDownloads.get(normalizedPath);
        return; // Result is now in _publicMediaCache
      }

      // Check cache again (may have been populated while we waited for semaphore)
      if (_publicMediaCache.has(normalizedPath)) return;

      const absoluteUrl = `${ASCENT_BASE}${normalizedPath}`;
      // Decode URL-encoded characters (e.g. %20 → space) so S3 keys contain
      // actual characters. The URL returned by uploadMediaToS3 will re-encode
      // them properly, ensuring browsers can fetch the resource.
      const decodedPath = decodeURIComponent(normalizedPath);

      // Register this download as pending so concurrent modules await it
      const downloadPromise = (async () => {
        const result = await downloadPublicFile(absoluteUrl);
        if (!result) {
          _publicMediaCache.set(normalizedPath, { url: absoluteUrl, failed: true });
          return;
        }

        try {
          let uploadBuffer = result.buffer;
          let uploadContentType = result.contentType;
          let uploadPath = decodedPath;
          const sourceExt = inferExtensionFromUrl(decodedPath);

          if (isLegacyBrowserVideoExtension(sourceExt)) {
            uploadBuffer = await transcodeVideoBufferToMp4(result.buffer, sourceExt);
            uploadContentType = 'video/mp4';
            uploadPath = replaceExtension(decodedPath, '.mp4');
            console.log(`    [public-media] transcoded ${normalizedPath} → ${uploadPath} (${result.buffer.length} → ${uploadBuffer.length} bytes)`);
          }

          const s3Key = `${S3_CONTENT_PREFIX}/${networkId}/${courseId}/v${version}/media/ascent${uploadPath}`;
          const presignedUrl = await uploadMediaToS3({
            buffer: uploadBuffer,
            key: s3Key,
            contentType: uploadContentType,
          });

          console.log(`    [public-media] ${normalizedPath} → S3 (${uploadBuffer.length} bytes)`);
          _publicMediaCache.set(normalizedPath, {
            url: presignedUrl,
            failed: false,
            s3Key,
            contentType: uploadContentType,
            size: uploadBuffer.length,
          });
        } catch (err) {
          console.warn(`    [public-media] S3 upload failed for ${normalizedPath}: ${err.message}`);
          _publicMediaCache.set(normalizedPath, { url: absoluteUrl, failed: true });
        }
      })();

      _pendingDownloads.set(normalizedPath, downloadPromise);
      try {
        await downloadPromise;
      } finally {
        _pendingDownloads.delete(normalizedPath);
      }
    });

  // Execute with concurrency limit
  if (tasks.length > 0) {
    await runWithConcurrency(tasks, CONCURRENCY_LIMIT);
  }

  // Rewrite HTML — replace each match with the cached URL (S3 presigned or fallback)
  for (const match of matches) {
    const cached = _publicMediaCache.get(match.normalized);
    const resolvedUrl = cached ? cached.url : match.absoluteUrl;

    html = html.replace(match.fullMatch, `${match.attr}${match.quote}${resolvedUrl}${match.quote}`);

    const entry = {
      original: match.rawPath,
      resolved: resolvedUrl,
      action: cached && !cached.failed ? 'public-media-download-to-s3' : 'rewrite-relative-to-absolute',
      status: cached && !cached.failed ? 'resolved' : 'failed',
    };

    if (cached && !cached.failed) {
      entry.s3Key = cached.s3Key;
      entry.contentType = cached.contentType;
      entry.size = cached.size;
    }

    if (cached && cached.failed) {
      entry.error = 'Download or upload failed — falling back to absolute Ascent URL';
    }

    entries.push(entry);
  }

  return { html, entries };
}

// ---------------------------------------------------------------------------
// Category 2: Hash-based file URLs → download to S3
// ---------------------------------------------------------------------------

/**
 * Find all hash-based file URLs in the HTML.
 *
 * Pattern: /files/{networkId}-{hexhash} (relative or absolute).
 * These return 403 without Ascent auth cookies.
 *
 * @param {string} html
 * @returns {string[]} Array of unique URL paths (relative form, e.g. "/files/668-abc123...")
 */
function findHashFileUrls(html) {
  const urls = new Set();

  // Match both src and href attributes pointing to hash files.
  // Hash files: /files/{digits}-{hex string of 40+ chars}
  const pattern = /(?:src|href)\s*=\s*["']((?:https?:\/\/ascent\.aerostudies\.com)?\/files\/\d+-[0-9a-f]{20,})["']/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    // Normalise to relative path for deduplication
    let url = match[1];
    url = url.replace(/^https?:\/\/ascent\.aerostudies\.com/, '');
    urls.add(url);
  }

  return [...urls];
}

/**
 * Process all hash-based file URLs: download from Ascent, upload to S3,
 * and rewrite both src and href attributes in the HTML.
 *
 * @param {string} html
 * @param {Object} opts
 * @param {string} opts.networkId
 * @param {string} opts.courseId
 * @param {string} opts.version
 * @param {string} opts.ascentCookies
 * @returns {Promise<{ html: string, entries: Array }>}
 */
async function resolveHashFiles(html, { networkId, courseId, version, ascentCookies }) {
  const hashUrls = findHashFileUrls(html);
  if (hashUrls.length === 0) return { html, entries: [] };

  const entries = [];

  // Build download + upload tasks
  const tasks = hashUrls.map(relativePath => async () => {
    const entry = {
      original: relativePath,
      resolved: null,
      action: 'hash-file-download-to-s3',
      status: 'pending',
    };

    try {
      if (!ascentCookies) {
        throw new Error('No Ascent cookies provided — cannot download authenticated files');
      }

      // Download from Ascent
      const { buffer, contentType, extension } = await downloadHashFile(relativePath, ascentCookies);

      // Derive filename: use the hash portion with the detected extension
      const hashFilename = relativePath.split('/').pop();
      const s3Key = `${S3_CONTENT_PREFIX}/${networkId}/${courseId}/v${version}/media/${hashFilename}${extension}`;

      // Upload to S3 (idempotent)
      const presignedUrl = await uploadMediaToS3({ buffer, key: s3Key, contentType });

      entry.resolved = presignedUrl;
      entry.s3Key = s3Key;
      entry.contentType = contentType;
      entry.size = buffer.length;
      entry.status = 'resolved';
    } catch (err) {
      entry.status = 'failed';
      entry.error = err.message;
    }

    return entry;
  });

  // Execute with concurrency limit
  const results = await runWithConcurrency(tasks, CONCURRENCY_LIMIT);

  // Rewrite HTML for each successfully resolved hash file
  for (const entry of results) {
    entries.push(entry);

    if (entry.status !== 'resolved' || !entry.resolved) continue;

    // Escape the original path for use in regex (it contains hyphens, slashes, etc.)
    const escaped = escapeRegex(entry.original);

    // Replace both relative and absolute forms in src and href attributes.
    // This handles: src="/files/668-abc..." and src="https://ascent.aerostudies.com/files/668-abc..."
    const rewritePattern = new RegExp(
      `((?:src|href)\\s*=\\s*)(["'])((?:https?://ascent\\.aerostudies\\.com)?${escaped})\\2`,
      'gi'
    );
    html = html.replace(rewritePattern, `$1$2${entry.resolved}$2`);
  }

  return { html, entries };
}

// ---------------------------------------------------------------------------
// Category 3: Vzaar/Vimeo video iframes
// ---------------------------------------------------------------------------

/**
 * Resolve Vzaar/Vimeo video iframes.
 *
 * The Ascent content uses iframes with class "vzaar-video-player" pointing to
 * /content/showVideo/{id}. These redirect to player.vimeo.com/video/{id},
 * but Vimeo domain-restricts them. The content often includes a fallback
 * <video> element with a <source> mp4 in the same block.
 *
 * Strategy:
 *   1. If a sibling <video> with <source src="...mp4"> exists: strip the iframe,
 *      keep the <video>, rewrite the mp4 src to an absolute Ascent URL.
 *   2. Otherwise: attempt yt-dlp download, upload to S3, replace iframe with <video>.
 *   3. If all fails: leave iframe as-is, report as failed.
 *
 * @param {string} html
 * @param {Object} opts
 * @param {string} opts.networkId
 * @param {string} opts.courseId
 * @param {string} opts.version
 * @returns {Promise<{ html: string, entries: Array }>}
 */
async function resolveVideoIframes(html, { networkId, courseId, version }) {
  const entries = [];

  // Find all vzaar iframe blocks. Ascent emits two shapes for these iframes:
  //   (newer, ~2021+)  <iframe ... class="vzaar-video-player" ... src="/content/showVideo/{id}" ... data-vidid="{vzaarId}">
  //   (older)          <iframe ... title="vzaar video player" ... src="/content/showVideo/{id}">          (no class, no data-vidid)
  // Matching on src="/content/showVideo/..." covers both shapes; it is also
  // the authoritative signal (the URL pattern is what makes this a Vzaar/Vimeo
  // iframe, not the label attributes).
  const iframePattern = /<iframe[^>]*src\s*=\s*["'][^"']*\/content\/showVideo\/\d+[^"']*["'][^>]*>/gi;
  const iframeMatches = [];
  let iframeMatch;
  while ((iframeMatch = iframePattern.exec(html)) !== null) {
    const tag = iframeMatch[0];
    const idx = iframeMatch.index;

    // Extract the showVideo ID from src attribute
    // Supports compound Vimeo IDs like /content/showVideo/848107790/6ce1d14d50
    const srcMatch = tag.match(/src\s*=\s*["']([^"']*\/content\/showVideo\/(\d+)(?:\/([a-f0-9]+))?)['"]/i);
    // Extract the vzaar/vimeo ID from data-vidid attribute
    // Supports compound IDs like data-vidid="848107790/6ce1d14d50"
    const vidIdMatch = tag.match(/data-vidid\s*=\s*["'](\d+)(?:\/([a-f0-9]+))?["']/i);

    iframeMatches.push({
      tag,
      index: idx,
      showVideoUrl: srcMatch ? srcMatch[1] : null,
      showVideoId: srcMatch ? srcMatch[2] : null,
      showVideoHash: srcMatch ? srcMatch[3] || null : null,
      vidId: vidIdMatch ? vidIdMatch[1] : null,
      vidIdHash: vidIdMatch ? vidIdMatch[2] || null : null,
    });
  }

  if (iframeMatches.length === 0) return { html, entries };

  // Step 2: For each iframe, look for a companion <video> with mp4 <source>
  // Process in reverse order so index offsets remain stable during replacement
  for (let i = iframeMatches.length - 1; i >= 0; i--) {
    const iframe = iframeMatches[i];
    const entry = {
      original: iframe.showVideoUrl || iframe.tag.substring(0, 80) + '...',
      vidId: iframe.vidId,
      resolved: null,
      action: 'vzaar-video-resolution',
      status: 'pending',
    };

    // Look in a window around the iframe for a companion <video> block
    // The pattern is typically within the same table cell or parent span.
    const searchStart = Math.max(0, iframe.index - 200);
    const searchEnd = Math.min(html.length, iframe.index + 2000);
    const searchRegion = html.substring(searchStart, searchEnd);

    // Look for <video> with <source src="..."> that has a valid video URL.
    // Matches: .mp4 URLs (with optional query string), or S3 presigned URLs
    // (hash-based sources rewritten to S3 by Step 2).
    const videoSourcePattern = /<video[^>]*>[\s\S]*?<source\s+src\s*=\s*["']([^"']+\.mp4(?:\?[^"']*)?|https:\/\/aaa-courses\.s3\.[^"']+)["'][^>]*>[\s\S]*?<\/video>/i;
    const videoMatch = searchRegion.match(videoSourcePattern);

    if (videoMatch) {
      // Strategy A: Use the fallback mp4 source
      const mp4Path = videoMatch[1];
      const absoluteMp4 = mp4Path.startsWith('http')
        ? mp4Path
        : `${ASCENT_BASE}${mp4Path}`;

      // Match the full Froala two-span pattern (iframe span + video span) as a group.
      // Replace with a single clean <video> element to prevent double videos.
      const twoSpanPattern = new RegExp(
        '<span[^>]*class\\s*=\\s*["\'][^"\']*fr-video[^"\']*["\'][^>]*>\\s*' +
        escapeRegex(iframe.tag) +
        '[\\s\\S]*?</iframe>\\s*</span>' +
        '\\s*' +
        '<span[^>]*class\\s*=\\s*["\'][^"\']*fr-video[^"\']*["\'][^>]*>\\s*' +
        '<video[\\s\\S]*?</video>\\s*</span>',
        'i'
      );

      const twoSpanMatch = html.match(twoSpanPattern);
      if (twoSpanMatch) {
        // Replace both spans with a single clean video element
        const videoElement = `<video controls preload="metadata" width="560" height="350" style="max-width:100%;height:auto;"><source src="${absoluteMp4}" type="video/mp4"></video>`;
        html = html.replace(twoSpanMatch[0], videoElement);
      } else {
        // Fallback: try to remove just the iframe span
        const iframeSpanPattern = new RegExp(
          '<span[^>]*class\\s*=\\s*["\'][^"\']*fr-video[^"\']*["\'][^>]*>\\s*' +
          escapeRegex(iframe.tag) +
          '[\\s\\S]*?</iframe>\\s*</span>',
          'i'
        );

        const iframeSpanMatch = html.match(iframeSpanPattern);
        if (iframeSpanMatch) {
          html = html.replace(iframeSpanMatch[0], '');
        }

        // Rewrite the mp4 source URL from relative to absolute
        if (!mp4Path.startsWith('http')) {
          html = html.split(mp4Path).join(absoluteMp4);
        }
      }

      entry.resolved = absoluteMp4;
      entry.action = 'vzaar-replaced-with-mp4-fallback';
      entry.status = 'resolved';
      entries.push(entry);
      continue;
    }

    // Strategy B: Check if video already exists on S3 (using showVideo ID or vidId)
    {
      const candidateKeys = [];
      if (iframe.showVideoId) {
        candidateKeys.push(`${S3_CONTENT_PREFIX}/${networkId}/${courseId}/v${version}/media/vimeo_${iframe.showVideoId}.mp4`);
        candidateKeys.push(`${S3_CONTENT_PREFIX}/${networkId}/${courseId}/v${version}/media/video_${iframe.showVideoId}.mp4`);
      }
      if (iframe.vidId) {
        candidateKeys.push(`${S3_CONTENT_PREFIX}/${networkId}/${courseId}/v${version}/media/vimeo_${iframe.vidId}.mp4`);
        candidateKeys.push(`${S3_CONTENT_PREFIX}/${networkId}/${courseId}/v${version}/media/video_${iframe.vidId}.mp4`);
      }

      let foundOnS3 = false;
      for (const candidateKey of candidateKeys) {
        const exists = await s3ObjectExists(candidateKey);
        if (exists) {
          const directUrl = `${S3_DIRECT_BASE}/${candidateKey}`;

          // Replace the iframe (and its wrapping span) with a <video> element
          const iframeSpanPattern = new RegExp(
            escapeRegex('<span') +
            '[^>]*>' +
            '\\s*' +
            escapeRegex(iframe.tag) +
            '[\\s\\S]*?' +
            escapeRegex('</iframe>') +
            '\\s*' +
            escapeRegex('</span>'),
            'i'
          );
          const videoElement = `<video controls preload="metadata" width="560" height="350" style="max-width:100%;height:auto;"><source src="${directUrl}" type="video/mp4"></video>`;

          const iframeSpanMatch = html.match(iframeSpanPattern);
          if (iframeSpanMatch) {
            html = html.replace(iframeSpanMatch[0], videoElement);
          } else {
            html = html.replace(iframe.tag, videoElement);
          }

          entry.resolved = directUrl;
          entry.s3Key = candidateKey;
          entry.action = 'vzaar-resolved-from-s3';
          entry.status = 'resolved';
          foundOnS3 = true;
          break;
        }
      }

      if (foundOnS3) {
        entries.push(entry);
        continue;
      }
    }

    // Strategy C: No fallback mp4, not on S3 — resolve via browser → HLS → yt-dlp.
    //
    // Prefer showVideoId (which IS the Vimeo ID) over vidId (which may be a
    // Vzaar legacy ID). The browser loads the Vimeo player with an Ascent
    // referrer and extracts the signed HLS master URL from playerConfig; that
    // URL is then handed to yt-dlp for fragment download and mp4 merge.
    const vimeoId = iframe.showVideoId || iframe.vidId;
    if (vimeoId && process.env.SKIP_VIMEO_BROWSER_RESOLUTION === '1') {
      entry.ytdlpError = 'browser-based Vimeo resolution skipped by SKIP_VIMEO_BROWSER_RESOLUTION';
    } else if (vimeoId) {
      try {
        const vimeoHash = iframe.showVideoHash || iframe.vidIdHash;
        const hlsUrl = await resolveVimeoHlsUrl(vimeoId, vimeoHash);
        if (!hlsUrl) {
          entry.ytdlpError = 'browser did not return an HLS URL (player config missing or inaccessible)';
        } else {
          const videoBuffer = await downloadWithYtDlp(hlsUrl);

          if (videoBuffer) {
            const s3Key = `${S3_CONTENT_PREFIX}/${networkId}/${courseId}/v${version}/media/vimeo_${vimeoId}.mp4`;
            const presignedUrl = await uploadMediaToS3({
              buffer: videoBuffer,
              key: s3Key,
              contentType: 'video/mp4',
            });

            const videoElement = `<video controls preload="metadata" width="560" height="350" style="max-width:100%;height:auto;"><source src="${presignedUrl}" type="video/mp4"></video>`;
            html = html.replace(iframe.tag, videoElement);

            entry.resolved = presignedUrl;
            entry.s3Key = s3Key;
            entry.action = 'vzaar-downloaded-via-browser-ytdlp';
            entry.status = 'resolved';
            entries.push(entry);
            continue;
          }
          entry.ytdlpError = 'HLS download via yt-dlp failed';
        }
      } catch (err) {
        entry.ytdlpError = err.message;
      }
    }

    // Strategy D: All resolution attempts failed — replace with visible placeholder
    {
      const videoId = iframe.showVideoId || iframe.vidId || 'unknown';
      const placeholder = `<div class="video-unavailable"><div class="vu-icon">&#9654;</div><div class="vu-label">Video unavailable</div><div class="vu-id">ID: ${videoId}</div></div>`;

      // Try to replace the iframe + its wrapping span
      const iframeSpanPattern = new RegExp(
        '<span[^>]*class\\s*=\\s*["\'][^"\']*fr-video[^"\']*["\'][^>]*>\\s*' +
        escapeRegex(iframe.tag) +
        '[\\s\\S]*?</iframe>\\s*</span>',
        'i'
      );
      const iframeSpanMatch = html.match(iframeSpanPattern);
      if (iframeSpanMatch) {
        html = html.replace(iframeSpanMatch[0], placeholder);
      } else {
        // Replace just the iframe tag
        html = html.replace(iframe.tag, placeholder);
      }

      entry.status = 'failed';
      entry.error = 'No fallback mp4 found, not on S3, and yt-dlp download failed — replaced with placeholder';
      entries.push(entry);
    }
  }

  // Cleanup pass: remove orphan empty fr-video spans left after replacements
  html = html.replace(/<span[^>]*class\s*=\s*["'][^"']*fr-video[^"']*["'][^>]*>\s*<\/span>/gi, '');

  return { html, entries };
}

/**
 * Extract the signed HLS master URL from Vimeo playerConfig embedded in HTML.
 */
function extractBalancedJsonObject(text, openBraceIndex) {
  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let i = openBraceIndex; i < text.length; i += 1) {
    const ch = text[i];

    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (ch === '\\') {
        escaping = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(openBraceIndex, i + 1);
    }
  }

  return null;
}

function parseVimeoPlayerConfig(html) {
  const marker = 'window.playerConfig';
  const markerIndex = html.indexOf(marker);
  if (markerIndex === -1) return null;

  const equalsIndex = html.indexOf('=', markerIndex + marker.length);
  if (equalsIndex === -1) return null;

  const openBraceIndex = html.indexOf('{', equalsIndex);
  if (openBraceIndex === -1) return null;

  const jsonText = extractBalancedJsonObject(html, openBraceIndex);
  if (!jsonText) return null;

  try {
    return JSON.parse(jsonText);
  } catch (_) {
    return null;
  }
}

function getHlsUrlFromPlayerConfig(cfg) {
  const hls = cfg?.request?.files?.hls;
  const cdnKey = hls?.default_cdn;
  if (cdnKey && hls?.cdns?.[cdnKey]?.url) return hls.cdns[cdnKey].url;
  const firstCdn = hls?.cdns ? Object.values(hls.cdns).find(cdn => cdn?.url) : null;
  return firstCdn?.url || null;
}

async function fetchTextWithRetry(url, headers = {}) {
  return withTransientRetries(`fetch ${url}`, async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': 'AirAcademy-MediaResolver/1.0',
          ...headers,
        },
        signal: controller.signal,
        redirect: 'follow',
      });

      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} for ${url}`);
        err.httpStatus = res.status;
        throw err;
      }

      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  }, {
    shouldRetry: (err) => isRetryableHttpStatus(err.httpStatus) || isRetryableError(err),
  });
}

async function resolveVimeoHlsUrlDirect(vimeoId, vimeoHash) {
  const candidates = [];
  const showVideoPath = vimeoHash ? `/content/showVideo/${vimeoId}/${vimeoHash}` : `/content/showVideo/${vimeoId}`;
  candidates.push(`${ASCENT_BASE}${showVideoPath}`);
  if (vimeoHash) candidates.push(`https://player.vimeo.com/video/${vimeoId}?h=${vimeoHash}`);
  candidates.push(`https://player.vimeo.com/video/${vimeoId}`);

  for (const url of candidates) {
    for (const referer of VIMEO_EMBED_REFERERS) {
      try {
        const html = await fetchTextWithRetry(url, { Referer: referer, 'User-Agent': VIMEO_PLAYER_USER_AGENT });
        const cfg = parseVimeoPlayerConfig(html);
        const hlsUrl = cfg ? getHlsUrlFromPlayerConfig(cfg) : null;
        if (hlsUrl) return hlsUrl;
      } catch (_) {
        // Try the next (url x referer) combo, then fall to browser resolution.
      }
    }
  }

  return null;
}

async function resolveVimeoHlsUrl(vimeoId, vimeoHash) {
  const direct = await resolveVimeoHlsUrlDirect(vimeoId, vimeoHash);
  if (direct) return direct;
  return resolveVimeoHlsUrlViaBrowser(vimeoId, vimeoHash);
}

/**
 * Resolve the signed HLS master URL for a Vimeo video by loading the player
 * inside a real browser with the Ascent referrer set. The browser extracts
 * the `window.playerConfig` payload (which always contains the HLS CDN URL
 * for embeddable videos) and returns it.
 *
 * This is the fallback after direct referrer-based player fetch. It replaces
 * the prior "yt-dlp straight at player.vimeo.com with --referer"
 * path. That path depended on curl_cffi being installed inside yt-dlp's venv
 * to impersonate a real browser — Vimeo's bot detection otherwise 404s the
 * request. The browser path sidesteps that: Vimeo sees a real Chrome session
 * with a legitimate referring origin, so it happily hands over the HLS URL.
 * The HLS URL is pre-signed, so the subsequent fragment download needs no
 * impersonation.
 *
 * Uses the existing `dev-browser` CLI (same one `fetchModuleSnapshotViaBrowser`
 * uses for the Ascent scraper fallback). No new dependency.
 *
 * @param {string}      vimeoId    Vimeo numeric ID (from /content/showVideo/{id})
 * @param {string|null} vimeoHash  Optional privacy hash (from /content/showVideo/{id}/{hash})
 * @returns {Promise<string|null>} Signed HLS master URL, or null on failure
 */
function resolveVimeoHlsUrlViaBrowser(vimeoId, vimeoHash) {
  const { spawn } = require('child_process');

  const playerUrl = vimeoHash
    ? `https://player.vimeo.com/video/${vimeoId}?h=${vimeoHash}`
    : `https://player.vimeo.com/video/${vimeoId}`;

  const script = `
const page = await browser.newPage();
await page.setExtraHTTPHeaders({ Referer: '${VIMEO_EMBED_REFERERS[0]}' });
try {
  await page.goto(${JSON.stringify(playerUrl)}, {
    waitUntil: 'networkidle',
    timeout: 30000,
    referer: '${VIMEO_EMBED_REFERERS[0]}',
  });
} catch (_) {}
const cfg = await page.evaluate(() => {
  if (typeof window.playerConfig !== 'undefined') return window.playerConfig;
  const scripts = document.querySelectorAll('script');
  for (const s of scripts) {
    const m = s.textContent && s.textContent.match(/window\\.playerConfig\\s*=\\s*(\\{[\\s\\S]*?\\});/);
    if (m) { try { return JSON.parse(m[1]); } catch (_) {} }
  }
  return null;
});
const hls = cfg?.request?.files?.hls;
const cdnKey = hls?.default_cdn;
const hlsUrl = cdnKey ? hls?.cdns?.[cdnKey]?.url : null;
console.log(JSON.stringify({ hlsUrl }));
`;

  return new Promise((resolve) => {
    const devBrowser = process.env.DEV_BROWSER_BIN || 'dev-browser';
    const child = spawn(devBrowser, ['--browser', 'airacademy-media', '--timeout', '120'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });

    const timeout = setTimeout(() => child.kill('SIGTERM'), 120_000);
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        console.error(`    dev-browser exited ${code} resolving HLS for vimeo ${vimeoId}: ${stderr.trim().slice(0, 200)}`);
        resolve(null);
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        resolve(parsed.hlsUrl || null);
      } catch (err) {
        console.error(`    dev-browser JSON parse failed for vimeo ${vimeoId}: ${err.message}`);
        resolve(null);
      }
    });
    child.on('error', (err) => {
      clearTimeout(timeout);
      console.error(`    dev-browser spawn error for vimeo ${vimeoId}: ${err.message}`);
      resolve(null);
    });

    child.stdin.end(script);
  });
}

/**
 * Download a video using yt-dlp against a pre-signed HLS URL.
 *
 * Caller provides the HLS URL — typically extracted via
 * `resolveVimeoHlsUrlViaBrowser` for Vimeo content. Because the URL is
 * pre-signed, yt-dlp doesn't need referer spoofing or curl_cffi impersonation
 * to download the fragments.
 *
 * Returns null if yt-dlp is not installed or the download fails.
 *
 * @param {string} hlsUrl  Pre-signed HLS master playlist URL
 * @returns {Promise<Buffer|null>}  Merged mp4 buffer, or null on failure
 */
function downloadWithYtDlp(hlsUrl) {
  const { spawn } = require('child_process');
  const os = require('os');
  const tmpFile = path.join(os.tmpdir(), `ytdlp_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);

  return new Promise((resolve) => {
    const args = [
      '--no-warnings',
      '--format', 'bv*+ba/b',
      '--merge-output-format', 'mp4',
      '--output', tmpFile,
      hlsUrl,
    ];

    const child = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    child.stdout.resume();
    child.stderr.resume();

    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
    }, 300_000);

    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0 || !fs.existsSync(tmpFile)) {
        console.error(`    yt-dlp exited ${code} for HLS URL`);
        try { fs.unlinkSync(tmpFile); } catch (_) {}
        resolve(null);
        return;
      }
      try {
        const buffer = fs.readFileSync(tmpFile);
        fs.unlinkSync(tmpFile);
        if (buffer.length === 0) {
          resolve(null);
          return;
        }
        resolve(buffer);
      } catch (_) {
        resolve(null);
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      console.error(`    yt-dlp spawn error: ${err.message}`);
      try { fs.unlinkSync(tmpFile); } catch (_) {}
      resolve(null);
    });
  });
}

// ---------------------------------------------------------------------------
// Main: resolveMedia
// ---------------------------------------------------------------------------

/**
 * Resolve all media URLs in an HTML string from Ascent course content.
 *
 * Processes media in this order:
 *   1. Public Ascent media → download to S3, rewrite to presigned URLs
 *   2. Hash-based file URLs → download to S3 (auth required), rewrite to presigned URLs
 *   3. Vzaar/Vimeo iframes → resolve to working video
 *
 * @param {Object} opts
 * @param {string}  opts.html            Raw HTML content from a page
 * @param {string}  opts.networkId       Customer network ID (e.g. "668")
 * @param {string}  opts.courseId        Numeric course ID (e.g. "100007")
 * @param {string}  opts.version         Content version (e.g. "1")
 * @param {string|null} opts.ascentCookies  Ascent session cookies, or null for public-only
 * @returns {Promise<{ html: string, report: { resolved: Array, failed: Array } }>}
 */
async function resolveMedia({ html, networkId, courseId, version, ascentCookies }) {
  if (!html) {
    return { html: html || '', report: { resolved: [], failed: [] } };
  }

  const allResolved = [];
  const allFailed = [];

  // --- Step 1: Public Ascent media → download to S3 ---
  const relResult = await resolvePublicAscentMedia(html, { networkId, courseId, version });
  html = relResult.html;
  for (const entry of relResult.entries) {
    if (entry.status === 'resolved') {
      allResolved.push(entry);
    } else {
      allFailed.push(entry);
    }
  }

  // --- Step 2: Hash-based files → S3 ---
  const hashResult = await resolveHashFiles(html, {
    networkId,
    courseId,
    version,
    ascentCookies,
  });
  html = hashResult.html;
  for (const entry of hashResult.entries) {
    if (entry.status === 'resolved') {
      allResolved.push(entry);
    } else {
      allFailed.push(entry);
    }
  }

  // --- Step 3: Vzaar/Vimeo iframes → working video ---
  const videoResult = await resolveVideoIframes(html, {
    networkId,
    courseId,
    version,
  });
  html = videoResult.html;
  for (const entry of videoResult.entries) {
    if (entry.status === 'resolved') {
      allResolved.push(entry);
    } else {
      allFailed.push(entry);
    }
  }

  // --- Step 4: Strip orphan "original-video" elements left by Froala editor ---
  // When videos are re-uploaded in Ascent's Froala editor, the old <video> element
  // remains in the HTML with class="original-video", hidden by Ascent's CSS.
  // Our player shows them, causing 2-3 stacked video players per page.
  // Remove these orphan elements and their wrapping <span class="fr-video"> containers.
  html = html.replace(
    /<span[^>]*class="[^"]*fr-video[^"]*"[^>]*>\s*<video[^>]*class="[^"]*original-video[^"]*"[^>]*>[\s\S]*?<\/video>\s*<\/span>/gi,
    ''
  );

  // Clean up empty <p> tags left behind after orphan removal
  html = html.replace(/<p>\s*<\/p>/gi, '');

  // Final safety net: no deployed course should retain a domain-restricted
  // Ascent/Vzaar iframe. If all richer resolution strategies missed one, ship a
  // visible placeholder instead of a broken external iframe.
  html = replaceRemainingShowVideoIframes(html);

  // --- Post-processing: reconcile failures against final HTML ---
  // A URL that "failed" in an early step (e.g. /content/showVideo/ failing in
  // Step 1's public download) may have been successfully resolved by a later
  // step (e.g. Step 3's video iframe resolver which replaces the entire iframe).
  // Filter out any "failed" entries whose original URL no longer appears in the
  // final HTML — those were resolved by a subsequent step.
  const reconciledFailed = allFailed.filter(entry => {
    const original = entry.original;
    // Check if the original URL (or its absolute Ascent form) still exists in
    // the final HTML. If it does not, a later step removed/rewrote it.
    if (html.includes(original)) return true;
    // Also check the absolute form in case the original was relative
    if (!original.startsWith('http')) {
      const absoluteForm = `${ASCENT_BASE}${original.startsWith('/') ? '' : '/'}${original}`;
      if (html.includes(absoluteForm)) return true;
    }
    // The URL is gone from the final HTML — it was resolved by a later step
    return false;
  });

  // --- Unresolved-iframe accounting ---
  const {
    unresolvedIframes,
    unresolvedIframeIds,
    unresolvedAscentAssets,
  } = summarizeUnresolved(reconciledFailed);

  // Optional env-var threshold: throw with a clear list when set. Lets ops
  // wedge a fail-fast check into CI / batch runs without code changes.
  if (process.env.MEDIA_RESOLVER_FAIL_ON_UNRESOLVED === '1' && unresolvedIframes.length > 0) {
    const idsList = unresolvedIframeIds.join(', ') || '(no ids extracted)';
    throw new Error(
      `MEDIA_RESOLVER_FAIL_ON_UNRESOLVED=1 and ${unresolvedIframes.length} unresolved iframe(s) ` +
      `for course ${courseId} v${version} (network ${networkId}): ${idsList}. ` +
      `Strategy C chain (browser → HLS → yt-dlp) exhausted; placeholder shipped. ` +
      `See entry.ytdlpError on each failed entry for the per-iframe failure reason.`
    );
  }

  return {
    html,
    report: {
      resolved: allResolved,
      failed: reconciledFailed,
      unresolvedIframeCount: unresolvedIframes.length,
      unresolvedIframeIds,
      unresolvedAscentAssetCount: unresolvedAscentAssets.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/**
 * Escape a string for safe use in a RegExp constructor.
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Reference file helpers
// ---------------------------------------------------------------------------

/**
 * Cached wrapper around downloadHashFile.
 * Caches the raw download buffer by Ascent path so the same reference PDF
 * (e.g., FAA InFO 07015) is only downloaded from Ascent once across all
 * modules in the process.
 *
 * @param {string} url       Ascent path (e.g. "/files/668-abc123...")
 * @param {string} cookies   Ascent session cookies
 * @returns {Promise<{ buffer: Buffer, contentType: string, extension: string }>}
 */
async function cachedDownloadHashFile(url, cookies) {
  // Normalize the URL for cache key
  const cacheKey = url.replace(/^https?:\/\/ascent\.aerostudies\.com/, '');

  if (_referenceDownloadCache.has(cacheKey)) {
    return _referenceDownloadCache.get(cacheKey);
  }

  // Check for pending download of same file
  const pendingKey = `ref:${cacheKey}`;
  if (_pendingDownloads.has(pendingKey)) {
    await _pendingDownloads.get(pendingKey);
    return _referenceDownloadCache.get(cacheKey);
  }

  const downloadPromise = (async () => {
    const result = await downloadHashFile(url, cookies);
    _referenceDownloadCache.set(cacheKey, result);
    return result;
  })();

  _pendingDownloads.set(pendingKey, downloadPromise);
  try {
    return await downloadPromise;
  } finally {
    _pendingDownloads.delete(pendingKey);
  }
}

/**
 * Delete stale reference files on S3 that share the same name stem but have a
 * different extension.  This cleans up login-page HTML files that were uploaded
 * during a previous failed run (e.g. "FAA_InFO_07015.html" when the correct
 * file is "FAA_InFO_07015.pdf").
 *
 * @param {string} refsPrefix  S3 prefix for the refs folder (e.g. "courses/297/89489/refs/")
 * @param {string} safeName    Sanitised reference name (no extension)
 * @param {string} correctExt  The correct extension (e.g. ".pdf")
 */
async function deleteStaleRefFiles(refsPrefix, safeName, correctExt) {
  try {
    const listRes = await sendS3WithRetry(`S3 ListObjects ${refsPrefix}${safeName}`, () => new ListObjectsV2Command({
      Bucket: S3_BUCKET,
      Prefix: `${refsPrefix}${safeName}`,
    }));

    const correctKey = `${refsPrefix}${safeName}${correctExt}`;
    for (const obj of (listRes.Contents || [])) {
      if (obj.Key !== correctKey && obj.Key.startsWith(`${refsPrefix}${safeName}.`)) {
        console.log(`    [reference] Deleting stale ref file: ${obj.Key}`);
        await sendS3WithRetry(`S3 DeleteObject ${obj.Key}`, () => new DeleteObjectCommand({
          Bucket: S3_BUCKET,
          Key: obj.Key,
        }));
      }
    }
  } catch (err) {
    // Non-fatal — stale files just waste space
    console.warn(`    [reference] Warning: could not clean stale refs: ${err.message}`);
  }
}

/**
 * Upload a reference file to S3, always overwriting any existing object at
 * the same key (no idempotency skip).  Reference files are small and prior
 * runs may have uploaded the Ascent login page by mistake, so we always
 * force-write.
 *
 * @param {Object} opts
 * @param {Buffer} opts.buffer      File content
 * @param {string} opts.key         Full S3 key
 * @param {string} opts.contentType MIME type
 * @returns {Promise<string>} Direct S3 URL
 */
async function uploadReferenceToS3({ buffer, key, contentType }) {
  await sendS3WithRetry(`S3 PutObject ${key}`, () => new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  }));

  const encodedKey = encodeS3KeyForUrl(key);
  return `${S3_DIRECT_BASE}/${encodedKey}`;
}

const LEGACY_REFERENCE_S3_SOURCES = {
  '/RWSL_SAFO17011.pdf': ['courses/195/150152/refs/RWSL_SAFO_17011.pdf'],
  '/files/reference_library/90/RWSL_SAFO17011.pdf': ['courses/195/150152/refs/RWSL_SAFO_17011.pdf'],
};

function normalizeLegacyReferencePath(refPath) {
  const normalized = String(refPath || '').trim().replace(/^https?:\/\/ascent\.aerostudies\.com/i, '');
  if (!normalized) return '';
  if (LEGACY_REFERENCE_S3_SOURCES[normalized]) return normalized;
  if (!normalized.startsWith('/')) return `/${normalized}`;
  return normalized;
}

async function findReusableReferenceSource(refPath) {
  const normalized = normalizeLegacyReferencePath(refPath);
  const candidates = LEGACY_REFERENCE_S3_SOURCES[normalized] || [];
  if (!candidates.length) return null;

  for (const key of candidates) {
    try {
      const head = await sendS3WithRetry(`S3 HeadObject ${key}`, () => new HeadObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
      }));
      return {
        key,
        contentType: head.ContentType || 'application/pdf',
        extension: inferExtensionFromUrl(key) || '.pdf',
      };
    } catch (err) {
      const status = err && err.$metadata && err.$metadata.httpStatusCode;
      if (err && err.name !== 'NotFound' && status !== 404) throw err;
    }
  }
  return null;
}

async function copyReferenceFromS3({ sourceKey, key }) {
  await sendS3WithRetry(`S3 CopyObject ${sourceKey} -> ${key}`, () => new CopyObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    CopySource: `${S3_BUCKET}/${sourceKey}`,
    MetadataDirective: 'COPY',
  }));

  const encodedKey = encodeS3KeyForUrl(key);
  return `${S3_DIRECT_BASE}/${encodedKey}`;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * Bucket the reconciled-failed entries from resolveMedia into iframe failures
 * (Strategy D — browser→HLS→yt-dlp chain exhausted, placeholder shipped) and
 * unresolved Ascent asset URLs more broadly. Exported so callers and tests
 * can use the same definition.
 *
 * @param {Array<object>} reconciledFailed
 * @returns {{ unresolvedIframes: Array<object>, unresolvedIframeIds: Array<string>, unresolvedAscentAssets: Array<object> }}
 */
function summarizeUnresolved(reconciledFailed) {
  const list = Array.isArray(reconciledFailed) ? reconciledFailed : [];
  const unresolvedIframes = list.filter((entry) => {
    if (entry && entry.action && /vzaar|iframe|video/i.test(entry.action)) return true;
    if (entry && (entry.vidId || entry.showVideoId || entry.ytdlpError)) return true;
    return false;
  });
  const unresolvedIframeIds = unresolvedIframes
    .map((e) => e.vidId || e.showVideoId || e.original)
    .filter(Boolean);
  const unresolvedAscentAssets = list.filter((entry) => {
    const original = String((entry && entry.original) || '');
    if (original.includes('ascent.aerostudies.com')) return true;
    if (original.includes('/content/showVideo/')) return true;
    return false;
  });
  return { unresolvedIframes, unresolvedIframeIds, unresolvedAscentAssets };
}

function replaceRemainingShowVideoIframes(html) {
  const iframePattern = /<iframe[^>]*src\s*=\s*["'][^"']*\/content\/showVideo\/(\d+)(?:\/[a-f0-9]+)?[^"']*["'][^>]*>[\s\S]*?<\/iframe>/gi;
  return html.replace(iframePattern, (iframe, videoId) => {
    return `<div class="video-unavailable"><div class="vu-icon">&#9654;</div><div class="vu-label">Video unavailable</div><div class="vu-id">ID: ${videoId || 'unknown'}</div></div>`;
  });
}


// --- Shared cross-process asset lock (restored 2026-06-04 from media-resolver.js.op580.bak /
//     AirAcademy commit 6ff9158; dropped in the packages/course-builder restructure — required by
//     build-player.js's reference-asset path, which calls withSharedAssetLock). ---
const LOCK_ROOT = process.env.MEDIA_RESOLVER_LOCK_DIR || path.join(os.tmpdir(), 'airacademy-media-resolver-locks');
const SHARED_LOCK_STALE_MS = Number.parseInt(process.env.MEDIA_RESOLVER_SHARED_LOCK_STALE_MS || String(60 * 60 * 1000), 10);
const LOCK_POLL_MS = Number.parseInt(process.env.MEDIA_RESOLVER_LOCK_POLL_MS || '250', 10);

function lockName(key) {
  return crypto.createHash('sha1').update(String(key)).digest('hex');
}

function lockPath(scope, key) {
  return path.join(LOCK_ROOT, scope, `${lockName(key)}.lock`);
}

function ownerIsAlive(ownerPath) {
  try {
    const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
    const pid = Number(owner.pid);
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return err && err.code === 'EPERM';
    }
  } catch (_) {
    return false;
  }
}

function removeDeadOrStaleLock(dir) {
  const ownerPath = path.join(dir, 'owner.json');
  let stale = false;
  let ageMs = 0;
  try {
    const stat = fs.statSync(dir);
    ageMs = Date.now() - stat.mtimeMs;
    stale = ageMs > SHARED_LOCK_STALE_MS;
  } catch (_) {
    return;
  }

  if (!fs.existsSync(ownerPath) && ageMs < 5_000) return;

  if (!ownerIsAlive(ownerPath) || stale) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

async function acquireNamedLock(scope, key, owner = {}) {
  const dir = lockPath(scope, key);
  fs.mkdirSync(path.dirname(dir), { recursive: true });

  while (true) {
    try {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({
        pid: process.pid,
        at: new Date().toISOString(),
        scope,
        key: String(key).slice(0, 500),
        ...owner,
      }, null, 2));
      return () => {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
      };
    } catch (err) {
      if (err && err.code !== 'EEXIST') throw err;
      removeDeadOrStaleLock(dir);
      await sleep(LOCK_POLL_MS + Math.floor(Math.random() * 150));
    }
  }
}

async function withSharedAssetLock(key, fn) {
  const release = await acquireNamedLock('shared-assets', key);
  try {
    return await fn();
  } finally {
    release();
  }
}
// --- end shared asset lock ---


// --- Shared-reference cache (restored 2026-06-04 from media-resolver.js.op580.bak / AirAcademy
//     6ff9158; dropped in the packages/course-builder restructure — required by build-player.js's
//     reference-asset path: findSharedReferenceSource + uploadSharedReferenceToS3). ---
const SHARED_ASSET_PREFIX = (process.env.MEDIA_RESOLVER_SHARED_ASSET_PREFIX || `${S3_CONTENT_PREFIX}/shared`).replace(/^\/+|\/+$/g, '');

function sharedAssetCacheEnabled() {
  return !['0', 'false', 'no', 'off'].includes(String(process.env.MEDIA_RESOLVER_SHARED_CACHE ?? 'true').trim().toLowerCase());
}

function sharedReferenceStem(refPath) {
  const normalized = normalizeLegacyReferencePath(refPath);
  const base = path.basename(normalized.split('?')[0] || 'reference').replace(/\.[^.]+$/, '');
  const safeBase = (base || 'reference').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  const hash = crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 16);
  return `${SHARED_ASSET_PREFIX}/refs/${safeBase}-${hash}`;
}

function sharedReferenceCandidateExtensions(refPath) {
  const inferred = inferExtensionFromUrl(refPath);
  return [...new Set([inferred, '.pdf', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.txt', '.bin'].filter(Boolean))];
}

async function findSharedReferenceSource(refPath) {
  if (!sharedAssetCacheEnabled()) return null;
  const stem = sharedReferenceStem(refPath);
  for (const extension of sharedReferenceCandidateExtensions(refPath)) {
    const key = `${stem}${extension}`;
    try {
      const head = await sendS3WithRetry(`S3 HeadObject ${key}`, () => new HeadObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
      }));
      return { key, contentType: head.ContentType || 'application/octet-stream', extension };
    } catch (err) {
      const status = err && err.$metadata && err.$metadata.httpStatusCode;
      if (err && err.name !== 'NotFound' && status !== 404) throw err;
    }
  }
  return null;
}

async function uploadSharedReferenceToS3({ refPath, buffer, contentType, extension }) {
  if (!sharedAssetCacheEnabled()) return null;
  const key = `${sharedReferenceStem(refPath)}${extension || CONTENT_TYPE_TO_EXT[contentType] || '.bin'}`;
  const directUrl = await uploadMediaToS3({ buffer, key, contentType });
  return { key, directUrl };
}
// --- end shared-reference cache ---

module.exports = {
  findSharedReferenceSource,
  uploadSharedReferenceToS3,
  withSharedAssetLock,
  resolveMedia,
  loginToAscent,
  downloadHashFile,
  cachedDownloadHashFile,
  uploadMediaToS3,
  encodeS3KeyForUrl,
  uploadReferenceToS3,
  deleteStaleRefFiles,
  findReusableReferenceSource,
  copyReferenceFromS3,
  normalizeLegacyReferencePath,
  summarizeUnresolved,
  parseVimeoPlayerConfig,
  getHlsUrlFromPlayerConfig,
  isShowVideoPath,
  publicAscentRelativePattern,
  publicAscentAbsolutePattern,
};
