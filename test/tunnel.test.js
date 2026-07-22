import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wsBaseFromServer, cookieFromSetCookie, validatePort } from '../src/tunnel-client.js';

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
  ];
  for (const c of cases) {
    await t.test(c.name, () => assert.equal(validatePort(c.in), c.want));
  }
});
