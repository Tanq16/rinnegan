import { createReadStream, statSync } from 'node:fs';
import { pipeline } from 'node:stream';
import path from 'node:path';

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
};

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
}

export function serveStatic(req, res, publicDir, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return notFound(res);
  }
  const resolved = path.normalize(path.join(publicDir, decoded));
  if (resolved !== publicDir && !resolved.startsWith(publicDir + path.sep)) return notFound(res);

  let stat;
  try {
    stat = statSync(resolved);
  } catch {
    return notFound(res);
  }
  if (!stat.isFile()) return notFound(res);

  const type = CONTENT_TYPES[path.extname(resolved).toLowerCase()] || 'application/octet-stream';
  // no-cache = store but revalidate every request, so app/style updates always
  // reach long-lived browsers; vendored assets only change with a re-vendor,
  // so a day of freshness is fine. ETag makes revalidation a cheap 304.
  const etag = `"${stat.size}-${Math.floor(stat.mtimeMs)}"`;
  const headers = {
    'Content-Type': type,
    ETag: etag,
    'Cache-Control': decoded.startsWith('/vendor/') ? 'public, max-age=86400' : 'no-cache',
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  headers['Content-Length'] = stat.size;
  res.writeHead(200, headers);
  // pipeline (unlike pipe) destroys the read stream if the client disconnects
  // mid-transfer, so aborted downloads do not leak file descriptors
  pipeline(createReadStream(resolved), res, () => {});
}
