import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitProxyPath,
  needsTrailingSlash,
  resolveTarget,
  stripCookies,
  rewriteLocation,
  rewriteCookiePath,
  forwardHeaders,
  responseHeaders,
  serializeUpgrade,
  REQUEST_DROP,
  UPGRADE_DROP,
} from '../src/proxy.js';
import { validAliasName, sanitizeAliases } from '../src/proxies.js';

const SESSION = ['rinnegan', 'rinnegan_rt'];

test('splitProxyPath', async (t) => {
  const cases = [
    { name: 'bare port with trailing slash', in: '/proxy/8080/', want: { segment: '8080', prefix: '/proxy/8080', rest: '/' } },
    { name: 'alias with a deep path and query', in: '/proxy/ide/a/b.js?v=1', want: { segment: 'ide', prefix: '/proxy/ide', rest: '/a/b.js?v=1' } },
    { name: 'no trailing slash leaves an empty rest', in: '/proxy/ide', want: { segment: 'ide', prefix: '/proxy/ide', rest: '' } },
    { name: 'query directly on the segment', in: '/proxy/ide?x=1', want: { segment: 'ide', prefix: '/proxy/ide', rest: '?x=1' } },
    { name: 'fragment directly on the segment', in: '/proxy/ide#top', want: { segment: 'ide', prefix: '/proxy/ide', rest: '#top' } },
    { name: 'percent-encoding in the path is preserved verbatim', in: '/proxy/ide/a%20b', want: { segment: 'ide', prefix: '/proxy/ide', rest: '/a%20b' } },
    { name: 'empty segment', in: '/proxy/', want: null },
    { name: 'empty segment with a path', in: '/proxy//x', want: null },
    { name: 'not a proxy path', in: '/download?path=/x', want: null },
    // /proxies must not be swallowed by the /proxy/ prefix or the management API becomes unreachable.
    { name: 'the management route is not a proxy path', in: '/proxies', want: null },
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
  const aliases = { ide: 8080, notes: 3000 };

  await t.test('a numeric segment resolves as a port without consulting aliases', () => {
    assert.equal(resolveTarget('8080', {}), 8080);
  });

  await t.test('a named segment resolves through the alias table', () => {
    assert.equal(resolveTarget('ide', aliases), 8080);
  });

  await t.test('an unknown name does not resolve', () => {
    assert.equal(resolveTarget('nope', aliases), null);
  });

  // Inherited keys are truthy on any object literal, so a bare lookup would resolve /proxy/constructor to a function.
  await t.test('inherited object properties never resolve', () => {
    for (const name of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
      assert.equal(resolveTarget(name, aliases), null, `${name} must not resolve`);
    }
  });

  await t.test('out-of-range ports do not resolve', () => {
    for (const seg of ['0', '65536', '99999']) {
      assert.equal(resolveTarget(seg, aliases), null, `${seg} must not resolve`);
    }
  });

  // A zero-padded segment stays on the port branch, so it can never fall through to an alias of the same spelling.
  await t.test('leading zeros resolve to the same port', () => {
    assert.equal(resolveTarget('007700', aliases), 7700);
  });

  await t.test('a port at each end of the range resolves', () => {
    assert.equal(resolveTarget('1', {}), 1);
    assert.equal(resolveTarget('65535', {}), 65535);
  });
});

test('validAliasName', async (t) => {
  const cases = [
    { name: 'simple word', in: 'ide', want: true },
    { name: 'digits and dashes', in: 'my-app2', want: true },
    { name: 'single character', in: 'a', want: true },
    // An all-digit alias is dead on arrival: resolveTarget takes the port branch first.
    { name: 'all digits is unreachable', in: '8080', want: false },
    { name: 'leading dash', in: '-ide', want: false },
    { name: 'uppercase', in: 'IDE', want: false },
    { name: 'path separator', in: 'a/b', want: false },
    { name: 'traversal', in: '..', want: false },
    { name: 'dot', in: 'my.app', want: false },
    { name: 'empty', in: '', want: false },
    { name: 'over 32 characters', in: 'a'.repeat(33), want: false },
    { name: 'exactly 32 characters', in: 'a'.repeat(32), want: true },
    { name: 'not a string', in: 8080, want: false },
  ];
  for (const c of cases) {
    await t.test(c.name, () => {
      assert.equal(validAliasName(c.in), c.want);
    });
  }
});

test('sanitizeAliases', async (t) => {
  await t.test('drops entries that could never resolve and keeps the rest', () => {
    const got = sanitizeAliases({ ide: 8080, '8080': 22, BAD: 80, deep: 0, ok: '3000', 'a/b': 90 });
    assert.deepEqual({ ...got }, { ide: 8080, ok: 3000 });
  });

  await t.test('a numeric string port is normalized to a number', () => {
    assert.equal(sanitizeAliases({ ok: '3000' }).ok, 3000);
  });

  await t.test('non-object input yields an empty table', () => {
    for (const bad of [null, [], 'x', 42, undefined]) {
      assert.deepEqual({ ...sanitizeAliases(bad) }, {});
    }
  });

  await t.test('the result has no prototype, so inherited keys cannot leak in', () => {
    assert.equal(Object.getPrototypeOf(sanitizeAliases({ ide: 8080 })), null);
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
    { name: 'root-relative gets the prefix', in: '/login', want: '/proxy/ide/login' },
    { name: 'root-relative with query', in: '/a?b=1', want: '/proxy/ide/a?b=1' },
    { name: 'an absolute upstream URL is folded back under the prefix', in: 'http://127.0.0.1:8080/a?b=1#c', want: '/proxy/ide/a?b=1#c' },
    { name: 'localhost is treated as the same upstream', in: 'http://localhost:8080/a', want: '/proxy/ide/a' },
    // Rewriting an off-host redirect would silently proxy a third party through the session.
    { name: 'an external absolute URL is left alone', in: 'https://example.com/x', want: 'https://example.com/x' },
    { name: 'a different local port is left alone', in: 'http://127.0.0.1:9999/a', want: 'http://127.0.0.1:9999/a' },
    { name: 'protocol-relative is left alone', in: '//example.com/x', want: '//example.com/x' },
    { name: 'a relative path is left alone', in: 'next', want: 'next' },
    { name: 'empty', in: '', want: '' },
  ];
  for (const c of cases) {
    await t.test(c.name, () => {
      assert.equal(rewriteLocation(c.in, '/proxy/ide', 8080), c.want);
    });
  }
});

test('rewriteCookiePath', async (t) => {
  const cases = [
    { name: 'root path is scoped under the prefix', in: 'a=1; Path=/; HttpOnly', want: 'a=1; Path=/proxy/ide/; HttpOnly' },
    { name: 'a sub-path is scoped under the prefix', in: 'a=1; Path=/api', want: 'a=1; Path=/proxy/ide/api' },
    // A cookie with no Path defaults to the request directory, which is already inside the prefix, but making it explicit keeps it off sibling targets.
    { name: 'a cookie with no Path gets one', in: 'a=1; HttpOnly', want: 'a=1; HttpOnly; Path=/proxy/ide/' },
    { name: 'lowercase attribute is matched', in: 'a=1; path=/', want: 'a=1; Path=/proxy/ide/' },
    { name: 'a relative Path value is left alone rather than corrupted', in: 'a=1; Path=x', want: 'a=1; Path=x; Path=/proxy/ide/' },
    { name: 'other attributes survive', in: 'a=1; Path=/; Secure; SameSite=Lax', want: 'a=1; Path=/proxy/ide/; Secure; SameSite=Lax' },
  ];
  for (const c of cases) {
    await t.test(c.name, () => {
      assert.equal(rewriteCookiePath(c.in, '/proxy/ide'), c.want);
    });
  }
});

test('forwardHeaders', async (t) => {
  const base = { cookieNames: SESSION, prefix: '/proxy/ide', port: 8080, proto: 'https', remote: '10.0.0.1' };
  const build = (headers, drop = REQUEST_DROP) => forwardHeaders(headers, { ...base, drop });

  await t.test('the upstream sees its own address as Host and the original as X-Forwarded-Host', () => {
    const got = build({ host: 'terminal.example.com' });
    assert.equal(got.host, '127.0.0.1:8080');
    assert.equal(got['x-forwarded-host'], 'terminal.example.com');
  });

  await t.test('session cookies never reach the upstream', () => {
    const got = build({ cookie: 'rinnegan=secret; theme=dark' });
    assert.equal(got.cookie, 'theme=dark');
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
    assert.equal(got['x-forwarded-prefix'], '/proxy/ide');
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
    const got = responseHeaders({ connection: 'keep-alive', 'transfer-encoding': 'chunked', 'content-type': 'text/html' }, '/proxy/ide', 8080);
    assert.deepEqual(got, { 'content-type': 'text/html' });
  });

  await t.test('every Set-Cookie in a multi-cookie response is scoped', () => {
    const got = responseHeaders({ 'set-cookie': ['a=1; Path=/', 'b=2; Path=/api'] }, '/proxy/ide', 8080);
    assert.deepEqual(got['set-cookie'], ['a=1; Path=/proxy/ide/', 'b=2; Path=/proxy/ide/api']);
  });

  await t.test('a single-string Set-Cookie is still returned as an array', () => {
    const got = responseHeaders({ 'set-cookie': 'a=1; Path=/' }, '/proxy/ide', 8080);
    assert.deepEqual(got['set-cookie'], ['a=1; Path=/proxy/ide/']);
  });

  await t.test('a redirect is rewritten in place', () => {
    assert.equal(responseHeaders({ location: '/login' }, '/proxy/ide', 8080).location, '/proxy/ide/login');
  });
});

test('serializeUpgrade', async (t) => {
  await t.test('emits a request line and CRLF-terminated headers ending in a blank line', () => {
    const got = serializeUpgrade('GET', '/socket', { host: '127.0.0.1:8080', upgrade: 'websocket' });
    assert.equal(got, 'GET /socket HTTP/1.1\r\nhost: 127.0.0.1:8080\r\nupgrade: websocket\r\n\r\n');
  });

  // Node hands repeated headers back as an array; joining them would send one malformed line.
  await t.test('a repeated header is emitted as one line each', () => {
    const got = serializeUpgrade('GET', '/', { 'sec-websocket-protocol': ['a', 'b'] });
    assert.equal(got, 'GET / HTTP/1.1\r\nsec-websocket-protocol: a\r\nsec-websocket-protocol: b\r\n\r\n');
  });
});
