import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import {
  signSession,
  verifySession,
  parseCookies,
  serializeCookie,
  hashPassword,
  verifyPassword,
} from '../src/auth.js';

const SECRET = randomBytes(32);

function forge(payloadObj, secret) {
  const body = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest().toString('base64url');
  return body + '.' + sig;
}

const now = () => Math.floor(Date.now() / 1000);

test('signSession/verifySession round trip', () => {
  const token = signSession({ sub: 'alice', role: 'admin' }, SECRET, 3600);
  const payload = verifySession(token, SECRET);
  assert.equal(payload.sub, 'alice');
  assert.equal(payload.role, 'admin');
  assert.equal(payload.exp - payload.iat, 3600);
  assert.equal(typeof payload.sid, 'string');
  assert.equal(payload.sid.length, 16);
});

test('verifySession rejects bad tokens', async (t) => {
  const valid = signSession({ sub: 'alice', role: 'user' }, SECRET, 3600);
  const [body, sig] = valid.split('.');
  const flip = (s, ch) => (s[0] === ch ? ch + ch + s.slice(2) : ch + s.slice(1));

  const cases = [
    { name: 'null', token: null },
    { name: 'non-string', token: 12345 },
    { name: 'empty', token: '' },
    { name: 'no dot', token: 'notoken' },
    { name: 'leading dot', token: '.' + sig },
    { name: 'empty signature', token: body + '.' },
    { name: 'tampered body', token: flip(body, 'X') + '.' + sig },
    { name: 'tampered signature', token: body + '.' + flip(sig, 'X') },
    { name: 'wrong secret', token: signSession({ sub: 'a', role: 'user' }, randomBytes(32), 3600) },
    { name: 'expired via negative ttl', token: signSession({ sub: 'a', role: 'user' }, SECRET, -10) },
  ];
  for (const c of cases) {
    await t.test(c.name, () => {
      assert.equal(verifySession(c.token, SECRET), null);
    });
  }
});

test('verifySession validates the payload even with a valid signature', async (t) => {
  const cases = [
    { name: 'missing role', payload: { sub: 'a', exp: now() + 100 }, want: null },
    { name: 'missing sub', payload: { role: 'user', exp: now() + 100 }, want: null },
    { name: 'exp not a number', payload: { sub: 'a', role: 'user' }, want: null },
    { name: 'exp in the past', payload: { sub: 'a', role: 'user', exp: now() - 10 }, want: null },
    { name: 'array payload', payload: [], want: null },
    { name: 'well-formed', payload: { sub: 'a', role: 'user', exp: now() + 100 }, want: 'ok' },
  ];
  for (const c of cases) {
    await t.test(c.name, () => {
      const got = verifySession(forge(c.payload, SECRET), SECRET);
      if (c.want === 'ok') {
        assert.equal(got.sub, 'a');
        assert.equal(got.role, 'user');
      } else {
        assert.equal(got, null);
      }
    });
  }
});

test('verifySession rejects a validly-signed non-JSON body', () => {
  const body = Buffer.from('not json at all').toString('base64url');
  const sig = createHmac('sha256', SECRET).update(body).digest().toString('base64url');
  assert.equal(verifySession(body + '.' + sig, SECRET), null);
});

test('parseCookies', async (t) => {
  const cases = [
    { name: 'undefined header', in: undefined, want: {} },
    { name: 'empty header', in: '', want: {} },
    { name: 'single pair', in: 'rinnegan=abc', want: { rinnegan: 'abc' } },
    { name: 'multiple pairs', in: 'a=1; b=2', want: { a: '1', b: '2' } },
    { name: 'trims whitespace', in: ' a = 1 ', want: { a: '1' } },
    { name: 'url-decodes the value', in: 'a=%20x', want: { a: ' x' } },
    { name: 'ignores a malformed percent escape', in: 'a=%zz', want: {} },
    { name: 'skips a pair with no equals', in: 'noequals', want: {} },
    { name: 'skips an empty name', in: '=noname', want: {} },
    { name: 'last duplicate wins', in: 'a=1; a=2', want: { a: '2' } },
    { name: 'value may contain equals', in: 'a=b=c', want: { a: 'b=c' } },
  ];
  for (const c of cases) {
    await t.test(c.name, () => {
      assert.deepEqual(parseCookies(c.in), c.want);
    });
  }
});

test('serializeCookie', async (t) => {
  await t.test('emits the hardening flags without Secure by default', () => {
    const cookie = serializeCookie('rinnegan', 'value', { maxAge: 100, secure: false });
    assert.match(cookie, /^rinnegan=value/);
    assert.match(cookie, /Max-Age=100/);
    assert.match(cookie, /Path=\//);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.doesNotMatch(cookie, /Secure/);
  });

  await t.test('appends Secure when requested', () => {
    const cookie = serializeCookie('rinnegan', 'value', { maxAge: 100, secure: true });
    assert.match(cookie, /; Secure$/);
  });

  await t.test('url-encodes the value', () => {
    const cookie = serializeCookie('rinnegan', 'a b/c', { maxAge: 0, secure: false });
    assert.match(cookie, /rinnegan=a%20b%2Fc/);
  });
});

test('hashPassword/verifyPassword round trip', async () => {
  const record = await hashPassword('correct horse battery staple');
  assert.equal(record.algorithm, 'scrypt');
  assert.equal(await verifyPassword('correct horse battery staple', record), true);
  assert.equal(await verifyPassword('wrong password', record), false);
});

test('verifyPassword rejects malformed or out-of-bounds records', async (t) => {
  const good = await hashPassword('pw');
  const mutate = (patch) => ({ ...good, ...patch });

  const cases = [
    { name: 'null record', record: null },
    { name: 'wrong algorithm', record: mutate({ algorithm: 'bcrypt' }) },
    { name: 'keyLength too large', record: mutate({ keyLength: 65 }) },
    { name: 'keyLength zero', record: mutate({ keyLength: 0 }) },
    { name: 'N not a power of two', record: mutate({ N: 16385 }) },
    { name: 'N too small', record: mutate({ N: 1 }) },
    { name: 'r out of range', record: mutate({ r: 0 }) },
    { name: 'p out of range', record: mutate({ p: 17 }) },
    { name: 'empty salt', record: mutate({ salt: '' }) },
    { name: 'empty hash', record: mutate({ hash: '' }) },
  ];
  for (const c of cases) {
    await t.test(c.name, async () => {
      assert.equal(await verifyPassword('pw', c.record), false);
    });
  }
});
