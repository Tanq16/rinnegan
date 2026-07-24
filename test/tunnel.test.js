import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wsBaseFromServer, cookieFromSetCookie, validatePort, parseMapping, parseTunnelConfig } from '../src/tunnel-client.js';

test('wsBaseFromServer maps scheme and preserves host/port', async (t) => {
  const cases = [
    { name: 'http -> ws', in: 'http://example.com', want: 'ws://example.com' },
    { name: 'https -> wss', in: 'https://example.com', want: 'wss://example.com' },
    { name: 'http with port', in: 'http://10.0.0.1:8442', want: 'ws://10.0.0.1:8442' },
    { name: 'https with port', in: 'https://10.0.0.1:8443', want: 'wss://10.0.0.1:8443' },
    { name: 'trailing slash dropped', in: 'https://example.com:8443/', want: 'wss://example.com:8443' },
    { name: 'path ignored', in: 'https://example.com/some/path', want: 'wss://example.com' },
  ];
  for (const c of cases) {
    await t.test(c.name, () => assert.equal(wsBaseFromServer(c.in), c.want));
  }
});

test('cookieFromSetCookie extracts the first name=value pair', async (t) => {
  const cases = [
    { name: 'single cookie string', in: 'rinnegan=abc123', want: 'rinnegan=abc123' },
    { name: 'attributes stripped', in: 'rinnegan=abc123; Path=/; HttpOnly; SameSite=Lax', want: 'rinnegan=abc123' },
    { name: 'array takes first', in: ['sid=xyz; Path=/', 'other=nope'], want: 'sid=xyz' },
    { name: 'custom cookie name', in: 'my_session=deadbeef; Max-Age=3600', want: 'my_session=deadbeef' },
    { name: 'null -> null', in: null, want: null },
    { name: 'undefined -> null', in: undefined, want: null },
    { name: 'empty string -> null', in: '', want: null },
    { name: 'empty array -> null', in: [], want: null },
    { name: 'no equals -> null', in: 'garbage', want: null },
    { name: 'leading equals -> null', in: '=value', want: null },
  ];
  for (const c of cases) {
    await t.test(c.name, () => assert.equal(cookieFromSetCookie(c.in), c.want));
  }
});

test('validatePort accepts 1..65535 integers only', async (t) => {
  const cases = [
    { name: 'null rejected', in: null, want: null },
    { name: 'undefined rejected', in: undefined, want: null },
    { name: '0 rejected', in: 0, want: null },
    { name: '1 ok', in: 1, want: 1 },
    { name: '65535 ok', in: 65535, want: 65535 },
    { name: '65536 rejected', in: 65536, want: null },
    { name: 'non-integer rejected', in: 3000.5, want: null },
    { name: 'NaN rejected', in: NaN, want: null },
    { name: 'negative rejected', in: -1, want: null },
    { name: 'numeric string ok', in: '3000', want: 3000 },
    { name: 'non-numeric string rejected', in: 'abc', want: null },
    { name: 'empty string rejected', in: '', want: null },
    { name: 'hex string rejected', in: '0x1f', want: null },
    { name: 'exponent string rejected', in: '1e3', want: null },
    { name: 'padded numeric string rejected', in: ' 80 ', want: null },
  ];
  for (const c of cases) {
    await t.test(c.name, () => assert.equal(validatePort(c.in), c.want));
  }
});

test('parseMapping normalizes every accepted form and rejects the rest', async (t) => {
  const cases = [
    { name: 'colon string', in: '8080:80', want: { local: 8080, remote: 80 } },
    { name: 'bare string shorthand', in: '3000', want: { local: 3000, remote: 3000 } },
    { name: 'bare number shorthand', in: 5432, want: { local: 5432, remote: 5432 } },
    { name: 'two-element array', in: [8080, 80], want: { local: 8080, remote: 80 } },
    { name: 'array of numeric strings', in: ['22', '2222'], want: { local: 22, remote: 2222 } },
    { name: 'boundary ports', in: '1:65535', want: { local: 1, remote: 65535 } },
    { name: 'missing remote', in: '8080:', throws: true },
    { name: 'missing local', in: ':80', throws: true },
    { name: 'lone colon', in: ':', throws: true },
    { name: 'three parts', in: '8080:80:9', throws: true },
    { name: 'port zero', in: '0:80', throws: true },
    { name: 'port over range', in: '8080:65536', throws: true },
    { name: 'non-numeric part', in: 'http:80', throws: true },
    { name: 'one-element array', in: [8080], throws: true },
    { name: 'three-element array', in: [1, 2, 3], throws: true },
    { name: 'bare invalid number', in: 70000, throws: true },
    { name: 'empty string', in: '', throws: true },
    { name: 'null', in: null, throws: true },
    { name: 'object', in: { local: 1 }, throws: true },
  ];
  for (const c of cases) {
    await t.test(c.name, () => {
      if (c.throws) return assert.throws(() => parseMapping(c.in));
      assert.deepEqual(parseMapping(c.in), c.want);
    });
  }
});

test('parseTunnelConfig validates shape and reports the bad field', async (t) => {
  await t.test('valid config normalizes all mappings', () => {
    assert.deepEqual(
      parseTunnelConfig({ server: 'https://h:8443', ports: ['8080:80', '3000', [22, 2222]] }),
      { server: 'https://h:8443', mappings: [
        { local: 8080, remote: 80 }, { local: 3000, remote: 3000 }, { local: 22, remote: 2222 },
      ] },
    );
  });

  const bad = [
    { name: 'null', in: null, msg: /JSON object/ },
    { name: 'array not object', in: ['https://h'], msg: /JSON object/ },
    { name: 'string not object', in: 'https://h', msg: /JSON object/ },
    { name: 'missing server', in: { ports: ['80'] }, msg: /"server" string/ },
    { name: 'empty server', in: { server: '  ', ports: ['80'] }, msg: /"server" string/ },
    { name: 'non-string server', in: { server: 8443, ports: ['80'] }, msg: /"server" string/ },
    { name: 'server unparseable', in: { server: 'ht tp://h', ports: ['80'] }, msg: /not a valid URL/ },
    { name: 'server missing scheme', in: { server: 'example.com:8443', ports: ['80'] }, msg: /http\(s\) URL/ },
    { name: 'server ws scheme rejected', in: { server: 'ws://h:8443', ports: ['80'] }, msg: /http\(s\) URL/ },
    { name: 'missing ports', in: { server: 'https://h' }, msg: /"ports" array/ },
    { name: 'empty ports', in: { server: 'https://h', ports: [] }, msg: /"ports" array/ },
    { name: 'ports not an array', in: { server: 'https://h', ports: '80' }, msg: /"ports" array/ },
    { name: 'bad mapping propagates', in: { server: 'https://h', ports: ['8080:bad'] }, msg: /invalid port mapping/ },
    { name: 'duplicate local port', in: { server: 'https://h', ports: ['8080:80', '8080:81'] }, msg: /duplicate local port 8080/ },
  ];
  for (const c of bad) {
    await t.test(c.name, () => assert.throws(() => parseTunnelConfig(c.in), c.msg));
  }
});
