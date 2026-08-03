import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitProxyPath,
  needsTrailingSlash,
  resolveTarget,
  stripCookies,
  rewriteLocation,
  rewriteCookiePath,
  refererTarget,
  forwardHeaders,
  responseHeaders,
  serializeUpgrade,
  REQUEST_DROP,
  UPGRADE_DROP,
} from '../src/proxy.js';

const SESSION = ['rinnegan', 'rinnegan_rt'];
const PREFIX = '/_rinnegan/proxy/9099';

test('splitProxyPath', async (t) => {
  const cases = [
    { name: 'port with trailing slash', in: '/_rinnegan/proxy/8080/', want: { segment: '8080', prefix: '/_rinnegan/proxy/8080', rest: '/' } },
    { name: 'deep path with a query', in: '/_rinnegan/proxy/8080/a/b.js?v=1', want: { segment: '8080', prefix: '/_rinnegan/proxy/8080', rest: '/a/b.js?v=1' } },
    { name: 'no trailing slash leaves an empty rest', in: '/_rinnegan/proxy/8080', want: { segment: '8080', prefix: '/_rinnegan/proxy/8080', rest: '' } },
    { name: 'query directly on the segment', in: '/_rinnegan/proxy/8080?x=1', want: { segment: '8080', prefix: '/_rinnegan/proxy/8080', rest: '?x=1' } },
    { name: 'fragment directly on the segment', in: '/_rinnegan/proxy/8080#top', want: { segment: '8080', prefix: '/_rinnegan/proxy/8080', rest: '#top' } },
    { name: 'percent-encoding in the path is preserved verbatim', in: '/_rinnegan/proxy/8080/a%20b', want: { segment: '8080', prefix: '/_rinnegan/proxy/8080', rest: '/a%20b' } },
    { name: 'empty segment', in: '/_rinnegan/proxy/', want: null },
    { name: 'empty segment with a path', in: '/_rinnegan/proxy//x', want: null },
    // The un-namespaced spelling must not resolve, or an upstream serving its own /proxy/ tree would be hijacked.
    { name: 'a bare /proxy/ path is not rinnegan\'s', in: '/proxy/8080/', want: null },
    { name: 'another namespaced route is not a proxy path', in: '/_rinnegan/download?path=/x', want: null },
    { name: 'an upstream path outside the namespace', in: '/static/app.js', want: null },
  ];
  for (const c of cases) {
    await t.test(c.name, () => {
      assert.deepEqual(splitProxyPath(c.in), c.want);
    });
  }
});

test('needsTrailingSlash', async (t) => {
  for (const [rest, want] of [['', true], ['?x=1', true], ['#top', true], ['/', false], ['/a', false]]) {
    await t.test(`${JSON.stringify(rest)} -> ${want}`, () => {
      assert.equal(needsTrailingSlash(rest), want);
    });
  }
});

test('resolveTarget', async (t) => {
  await t.test('a port at each end of the range resolves', () => {
    assert.equal(resolveTarget('1'), 1);
    assert.equal(resolveTarget('65535'), 65535);
  });

  await t.test('out-of-range ports do not resolve', () => {
    for (const seg of ['0', '65536', '99999']) {
      assert.equal(resolveTarget(seg), null, `${seg} must not resolve`);
    }
  });

  await t.test('a non-numeric segment does not resolve', () => {
    for (const seg of ['ide', '', '80a', '-1', '8.0', 'constructor']) {
      assert.equal(resolveTarget(seg), null, `${seg} must not resolve`);
    }
  });

  await t.test('leading zeros resolve to the same port', () => {
    assert.equal(resolveTarget('007700'), 7700);
  });
});

test('stripCookies', async (t) => {
  const cases = [
    { name: 'removes only the session cookies', in: 'rinnegan=abc; theme=dark; rinnegan_rt=def', want: 'theme=dark' },
    { name: 'keeps unrelated cookies untouched', in: 'a=1; b=2', want: 'a=1; b=2' },
    { name: 'a header of only session cookies yields nothing to forward', in: 'rinnegan=abc; rinnegan_rt=def', want: null },
    { name: 'empty header', in: '', want: null },
    { name: 'missing header', in: undefined, want: null },
    // A prefix match would strip an upstream cookie that merely starts with the session name.
    { name: 'a cookie whose name only starts with the session name is kept', in: 'rinnegan_theme=x', want: 'rinnegan_theme=x' },
    { name: 'a valueless cookie is not mistaken for a session cookie', in: 'flag; a=1', want: 'flag; a=1' },
    { name: 'whitespace is normalized', in: 'a=1;   b=2', want: 'a=1; b=2' },
  ];
  for (const c of cases) {
    await t.test(c.name, () => {
      assert.equal(stripCookies(c.in, SESSION), c.want);
    });
  }
});

test('rewriteLocation', async (t) => {
  const cases = [
    { name: 'root-relative gets the prefix', in: '/login', want: `${PREFIX}/login` },
    { name: 'root-relative with query', in: '/a?b=1', want: `${PREFIX}/a?b=1` },
    { name: 'an absolute upstream URL is folded back under the prefix', in: 'http://127.0.0.1:9099/a?b=1#c', want: `${PREFIX}/a?b=1#c` },
    { name: 'localhost is treated as the same upstream', in: 'http://localhost:9099/a', want: `${PREFIX}/a` },
    // Rewriting an off-host redirect would silently proxy a third party through the session.
    { name: 'an external absolute URL is left alone', in: 'https://example.com/x', want: 'https://example.com/x' },
    { name: 'a different local port is left alone', in: 'http://127.0.0.1:9999/a', want: 'http://127.0.0.1:9999/a' },
    { name: 'protocol-relative is left alone', in: '//example.com/x', want: '//example.com/x' },
    { name: 'a relative path is left alone', in: 'next', want: 'next' },
    { name: 'empty', in: '', want: '' },
  ];
  for (const c of cases) {
    await t.test(c.name, () => {
      assert.equal(rewriteLocation(c.in, PREFIX, 9099), c.want);
    });
  }
});

test('rewriteCookiePath', async (t) => {
  const cases = [
    { name: 'root path is scoped under the prefix', in: 'a=1; Path=/; HttpOnly', want: `a=1; Path=${PREFIX}/; HttpOnly` },
    { name: 'a sub-path is scoped under the prefix', in: 'a=1; Path=/api', want: `a=1; Path=${PREFIX}/api` },
    // A cookie with no Path defaults to the request directory, which is already inside the prefix, but making it explicit keeps it off sibling targets.
    { name: 'a cookie with no Path gets one', in: 'a=1; HttpOnly', want: `a=1; HttpOnly; Path=${PREFIX}/` },
    { name: 'lowercase attribute is matched', in: 'a=1; path=/', want: `a=1; Path=${PREFIX}/` },
    { name: 'a relative Path value is left alone rather than corrupted', in: 'a=1; Path=x', want: `a=1; Path=x; Path=${PREFIX}/` },
    { name: 'other attributes survive', in: 'a=1; Path=/; Secure; SameSite=Lax', want: `a=1; Path=${PREFIX}/; Secure; SameSite=Lax` },
  ];
  for (const c of cases) {
    await t.test(c.name, () => {
      assert.equal(rewriteCookiePath(c.in, PREFIX), c.want);
    });
  }
});

test('refererTarget', async (t) => {
  await t.test('a request from a proxied page recovers its prefix', () => {
    assert.equal(refererTarget('https://term.example.com/_rinnegan/proxy/9099/docs/readme.md'), PREFIX);
  });

  await t.test('a query or fragment on the referring page does not disturb the prefix', () => {
    assert.equal(refererTarget('https://term.example.com/_rinnegan/proxy/9099/a?x=1#y'), PREFIX);
  });

  await t.test('the target page itself, with no path, still resolves', () => {
    assert.equal(refererTarget('https://term.example.com/_rinnegan/proxy/9099/'), PREFIX);
  });

  await t.test('a referrer from rinnegan\'s own pages is not a proxy context', () => {
    for (const r of ['https://term.example.com/', 'https://term.example.com/_rinnegan/login']) {
      assert.equal(refererTarget(r), null, `${r} must not resolve`);
    }
  });

  // Redirecting to a target that cannot resolve would answer a 404 one round trip later.
  await t.test('a referrer naming an unusable target does not redirect', () => {
    assert.equal(refererTarget('https://term.example.com/_rinnegan/proxy/99999/x'), null);
    assert.equal(refererTarget('https://term.example.com/_rinnegan/proxy/ide/x'), null);
  });

  await t.test('a missing or malformed referrer is ignored', () => {
    for (const r of [undefined, '', 'not a url', '/_rinnegan/proxy/9099/x']) {
      assert.equal(refererTarget(r), null, `${JSON.stringify(r)} must not resolve`);
    }
  });
});

test('forwardHeaders', async (t) => {
  const base = { cookieNames: SESSION, prefix: PREFIX, port: 9099, proto: 'https', remote: '10.0.0.1' };
  const build = (headers, drop = REQUEST_DROP) => forwardHeaders(headers, { ...base, drop });

  await t.test('the upstream sees its own address as Host and the original as X-Forwarded-Host', () => {
    const got = build({ host: 'term.example.com' });
    assert.equal(got.host, '127.0.0.1:9099');
    assert.equal(got['x-forwarded-host'], 'term.example.com');
  });

  await t.test('session cookies never reach the upstream', () => {
    assert.equal(build({ cookie: 'rinnegan=secret; theme=dark' }).cookie, 'theme=dark');
  });

  await t.test('a cookie header of only session cookies is dropped entirely', () => {
    assert.equal(Object.hasOwn(build({ cookie: 'rinnegan=secret' }), 'cookie'), false);
  });

  // A CR/LF in any value would inject extra headers into the hand-serialized upgrade request.
  await t.test('header values carrying CR or LF are dropped', () => {
    const got = build({ 'x-evil': 'a\r\nX-Injected: 1', 'x-also-evil': 'b\nc', 'x-fine': 'ok' });
    assert.equal(Object.hasOwn(got, 'x-evil'), false);
    assert.equal(Object.hasOwn(got, 'x-also-evil'), false);
    assert.equal(got['x-fine'], 'ok');
  });

  await t.test('an upstream-facing prefix and proto are always set', () => {
    const got = build({});
    assert.equal(got['x-forwarded-prefix'], PREFIX);
    assert.equal(got['x-forwarded-proto'], 'https');
  });

  await t.test('a front proxy\'s existing forwarded values win over the derived ones', () => {
    const got = build({ 'x-forwarded-proto': 'http', 'x-forwarded-for': '203.0.113.7' });
    assert.equal(got['x-forwarded-proto'], 'http');
    assert.equal(got['x-forwarded-for'], '203.0.113.7');
  });

  // Drop these on a plain request and forward them on an upgrade, or WebSockets never handshake.
  await t.test('the handshake headers are dropped for a request and kept for an upgrade', () => {
    const headers = { connection: 'Upgrade', upgrade: 'websocket', 'keep-alive': 'timeout=5' };
    const asRequest = build(headers, REQUEST_DROP);
    assert.equal(Object.hasOwn(asRequest, 'connection'), false);
    assert.equal(Object.hasOwn(asRequest, 'upgrade'), false);

    const asUpgrade = build(headers, UPGRADE_DROP);
    assert.equal(asUpgrade.connection, 'Upgrade');
    assert.equal(asUpgrade.upgrade, 'websocket');
    assert.equal(Object.hasOwn(asUpgrade, 'keep-alive'), false, 'other hop-by-hop headers still go');
  });
});

test('responseHeaders', async (t) => {
  await t.test('hop-by-hop headers are not passed back to the browser', () => {
    const got = responseHeaders({ connection: 'keep-alive', 'transfer-encoding': 'chunked', 'content-type': 'text/html' }, PREFIX, 9099);
    assert.deepEqual(got, { 'content-type': 'text/html' });
  });

  await t.test('every Set-Cookie in a multi-cookie response is scoped', () => {
    const got = responseHeaders({ 'set-cookie': ['a=1; Path=/', 'b=2; Path=/api'] }, PREFIX, 9099);
    assert.deepEqual(got['set-cookie'], [`a=1; Path=${PREFIX}/`, `b=2; Path=${PREFIX}/api`]);
  });

  await t.test('a single-string Set-Cookie is still returned as an array', () => {
    const got = responseHeaders({ 'set-cookie': 'a=1; Path=/' }, PREFIX, 9099);
    assert.deepEqual(got['set-cookie'], [`a=1; Path=${PREFIX}/`]);
  });

  await t.test('a redirect is rewritten in place', () => {
    assert.equal(responseHeaders({ location: '/login' }, PREFIX, 9099).location, `${PREFIX}/login`);
  });
});

test('serializeUpgrade', async (t) => {
  await t.test('emits a request line and CRLF-terminated headers ending in a blank line', () => {
    const got = serializeUpgrade('GET', '/socket', { host: '127.0.0.1:9099', upgrade: 'websocket' });
    assert.equal(got, 'GET /socket HTTP/1.1\r\nhost: 127.0.0.1:9099\r\nupgrade: websocket\r\n\r\n');
  });

  // Node hands repeated headers back as an array; joining them would send one malformed line.
  await t.test('a repeated header is emitted as one line each', () => {
    const got = serializeUpgrade('GET', '/', { 'sec-websocket-protocol': ['a', 'b'] });
    assert.equal(got, 'GET / HTTP/1.1\r\nsec-websocket-protocol: a\r\nsec-websocket-protocol: b\r\n\r\n');
  });
});
