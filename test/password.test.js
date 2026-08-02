import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadRecord, verify, setPassword, fingerprint } from '../src/password.js';

const SECRET = randomBytes(32);

let dir;
before(() => { dir = mkdtempSync(path.join(tmpdir(), 'rinnegan-auth-')); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

const freshFile = () => path.join(dir, `auth-${randomBytes(6).toString('hex')}.json`);

function writeRaw(value) {
  const p = freshFile();
  writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value));
  return p;
}

test('setPassword then verify round trip', async () => {
  const f = freshFile();
  await setPassword(f, 'secret-pw');
  assert.ok(await verify(f, 'secret-pw'));
  assert.equal(await verify(f, 'wrong-pw'), null);
  assert.equal(await verify(f, ''), null);
});

test('setPassword overwrites the existing record', async () => {
  const f = freshFile();
  await setPassword(f, 'old-pw');
  await setPassword(f, 'new-pw');
  assert.ok(await verify(f, 'new-pw'));
  assert.equal(await verify(f, 'old-pw'), null);
});

test('setPassword creates a missing parent directory and writes mode 0600', async () => {
  const f = path.join(dir, 'nested', `auth-${randomBytes(4).toString('hex')}.json`);
  await setPassword(f, 'pw');
  assert.equal(statSync(f).mode & 0o777, 0o600);
});

test('loadRecord rejects malformed files', async (t) => {
  const cases = [
    { name: 'not JSON', raw: 'not json', err: /invalid JSON in auth file/ },
    { name: 'no password key', raw: '{}', err: /must contain a "password" record/ },
    { name: 'password not an object', raw: '{"password":"hunter2"}', err: /must contain a "password" record/ },
    { name: 'null literal', raw: 'null', err: /must contain a "password" record/ },
    { name: 'array', raw: '[]', err: /must contain a "password" record/ },
  ];
  for (const c of cases) {
    await t.test(c.name, () => {
      assert.throws(() => loadRecord(writeRaw(c.raw)), c.err);
    });
  }
});

test('loadRecord throws when the file is missing', () => {
  assert.throws(() => loadRecord(path.join(dir, 'no-such-file.json')), /cannot read auth file/);
});

test('verify propagates a missing or malformed file rather than reporting a wrong password', async () => {
  await assert.rejects(() => verify(path.join(dir, 'absent.json'), 'pw'), /cannot read auth file/);
  await assert.rejects(() => verify(writeRaw('{}'), 'pw'), /must contain a "password" record/);
});

// The property that makes rotation invalidate live sessions: the salt is regenerated, so the hash moves even when the password does not.
test('fingerprint changes after setPassword even when the password is unchanged', async () => {
  const f = freshFile();
  await setPassword(f, 'same-pw');
  const before = fingerprint(loadRecord(f), SECRET);
  await setPassword(f, 'same-pw');
  const after = fingerprint(loadRecord(f), SECRET);
  assert.notEqual(before, after);
  assert.equal(after.length, 16);
});

test('fingerprint is stable for one record and keyed by the secret', async () => {
  const record = loadRecord(await (async () => { const f = freshFile(); await setPassword(f, 'pw'); return f; })());
  assert.equal(fingerprint(record, SECRET), fingerprint(record, SECRET));
  assert.notEqual(fingerprint(record, SECRET), fingerprint(record, randomBytes(32)));
});
