import { createReadStream, constants } from 'node:fs';
import { realpath, stat, access } from 'node:fs/promises';
import { pipeline } from 'node:stream';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { info, error } from './log.js';

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
}

function badRequest(res, msg) {
  res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(msg);
}

// Non-ASCII throws in header validation and quotes/backslashes break the quoted-string.
function attachment(name) {
  return 'attachment; filename="' + name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') + '"';
}

export async function handleDownload(req, res, searchParams, username) {
  const p = searchParams.get('path');
  if (!p) return badRequest(res, 'missing path');
  if (!p.startsWith('/')) return badRequest(res, 'path must be absolute');

  let resolved;
  let st;
  try {
    resolved = await realpath(p);
    st = await stat(resolved);
    await access(resolved, constants.R_OK);
  } catch {
    return notFound(res);
  }
  const head = req.method === 'HEAD';

  if (st.isFile()) {
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': st.size,
      'Content-Disposition': attachment(path.basename(resolved)),
      'Cache-Control': 'no-store',
    });
    if (head) return res.end();
    info('download: ' + username + ' ' + resolved);
    // pipeline (unlike pipe) destroys the read stream on client disconnect, so aborted downloads do not leak file descriptors
    pipeline(createReadStream(resolved), res, () => {});
    return;
  }

  if (st.isDirectory()) {
    const name = path.basename(resolved);
    if (!name) return badRequest(res, 'bad path');
    const headers = {
      'Content-Type': 'application/gzip',
      'Content-Disposition': attachment(name + '.tar.gz'),
      'Cache-Control': 'no-store',
    };
    if (head) {
      res.writeHead(200, headers);
      return res.end();
    }
    // -- ends option parsing so a directory whose name starts with '-' is a path, not a tar flag
    const child = spawn('tar', ['czf', '-', '-C', path.dirname(resolved), '--', name], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    child.on('error', (e) => {
      error('download tar: ' + e.message);
      res.destroy();
    });
    // The response must not finish until tar's exit code is known: stdout EOF precedes a non-zero exit, so ending on EOF would deliver a truncated archive as a clean 200.
    child.on('close', (code, signal) => {
      if (code === 0) {
        if (!res.destroyed) res.end();
        return;
      }
      if (signal === null) error('download tar exit ' + code + ': ' + resolved);
      res.destroy();
    });
    res.on('close', () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    });
    res.writeHead(200, headers);
    info('download: ' + username + ' ' + resolved);
    res.on('error', () => {});
    child.stdout.pipe(res, { end: false });
    return;
  }

  return notFound(res);
}
