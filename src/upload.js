import { createWriteStream } from 'node:fs';
import { mkdir, link, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { info } from './log.js';

// /tmp is deliberate (spec), not os.tmpdir(): predictable path the user references from a shell.
const UPLOAD_DIR = '/tmp';
const UPLOAD_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const MAX_BATCH_BODY = 4096;
const BATCH_TTL_MS = 60 * 60 * 1000;

const batches = new Map();

function randomPrefix() {
  const b = randomBytes(5);
  let s = '';
  for (let i = 0; i < 5; i++) s += UPLOAD_ALPHABET[b[i] % 36];
  return s;
}

// Basename-only, [A-Za-z0-9._-] with no leading dots: blocks path traversal and hidden-file writes.
export function safeName(name) {
  const base = String(name || '').split(/[\\/]/).pop() || '';
  const clean = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 100);
  return clean || 'file';
}

// Keep printable names verbatim (they never reach a shell); reject only traversal + control chars. Char-collapsing silently merged distinct files onto one path.
export function safeRelPath(rel) {
  const parts = String(rel || '').split(/[\\/]/);
  const out = [];
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..' || part.length > 255) return null;
    for (let i = 0; i < part.length; i++) {
      const c = part.charCodeAt(i);
      if (c < 0x20 || c === 0x7f) return null;
    }
    out.push(part);
  }
  return out.join('/');
}

export function resolveBatchDest(root, rel) {
  const safe = safeRelPath(rel);
  if (!safe) return null;
  const dest = path.resolve(root, safe);
  // containment re-check: the sanitizer must never be the only guard
  if (!dest.startsWith(root + path.sep)) return null;
  return dest;
}

function sweepBatches() {
  const now = Date.now();
  for (const [id, batch] of batches) {
    if (batch.expires <= now) batches.delete(id);
  }
}

function lookupBatch(batchId) {
  sweepBatches();
  const batch = batches.get(batchId);
  if (!batch) return null;
  batch.expires = Date.now() + BATCH_TTL_MS;
  return batch;
}

function badRequest(res, msg) {
  // close: the unread remainder of the body poisons keep-alive
  res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
  res.end(msg);
}

function conflict(res, msg) {
  // no close: 409 fires only after the body was fully streamed, so nothing is left to poison keep-alive
  res.writeHead(409, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(msg);
}

// Resolves null when the body exceeds MAX_BATCH_BODY (caller responds 400).
function readBatchBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      total += chunk.length;
      if (total > MAX_BATCH_BODY) {
        done = true;
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!done) {
        done = true;
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    });
    req.on('error', (err) => {
      if (!done) {
        done = true;
        reject(err);
      }
    });
  });
}

async function streamToFile(req, dest) {
  const tmp = dest + '.' + randomBytes(4).toString('hex') + '.part';
  try {
    await pipeline(req, createWriteStream(tmp, { flags: 'wx', mode: 0o600 }));
    // link, not rename: a folder-upload sibling that collides must fail (EEXIST), never clobber
    await link(tmp, dest);
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

export async function handleUpload(req, res, searchParams, username) {
  let dest;
  if (searchParams.get('batch') !== null) {
    const batch = lookupBatch(searchParams.get('batch'));
    if (!batch) return badRequest(res, 'unknown batch');
    dest = resolveBatchDest(batch.root, searchParams.get('path') ?? '');
    if (!dest) return badRequest(res, 'bad path');
    await mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
  } else {
    const name = searchParams.get('name');
    if (!name) return badRequest(res, 'missing name');
    dest = path.join(UPLOAD_DIR, randomPrefix() + '-' + safeName(name));
    if (!dest.startsWith(UPLOAD_DIR + '/')) return badRequest(res, 'bad path'); // defense in depth
  }

  try {
    await streamToFile(req, dest);
  } catch (e) {
    if (e.code === 'EEXIST') return conflict(res, 'a file already exists at that path');
    throw e;
  }
  info('upload: ' + username + ' ' + dest);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ path: dest }));
}

export async function handleUploadBatch(req, res) {
  const body = await readBatchBody(req);
  if (body === null) return badRequest(res, 'bad request');
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return badRequest(res, 'bad request');
  }
  if (typeof parsed?.name !== 'string' || !parsed.name) return badRequest(res, 'missing name');

  const root = path.join(UPLOAD_DIR, randomPrefix() + '-' + safeName(parsed.name));
  await mkdir(root, { mode: 0o700 });
  const batchId = randomBytes(8).toString('hex');
  sweepBatches();
  batches.set(batchId, { root, expires: Date.now() + BATCH_TTL_MS });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ batchId, root }));
}
