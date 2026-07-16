import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadUsers, verifyLogin, addUser, setPassword, listUsers } from '../src/users.js';

let dir;
before(() => { dir = mkdtempSync(path.join(tmpdir(), 'rinnegan-users-')); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

const freshFile = () => path.join(dir, `users-${randomBytes(6).toString('hex')}.json`);

function writeRaw(value) {
  const p = freshFile();
  writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value));
  return p;
}

test('addUser then verifyLogin round trip', async () => {
  const f = freshFile();
  await addUser(f, 'alice', 'admin', 'secret-pw');
  assert.deepEqual(await verifyLogin(f, 'alice', 'secret-pw'), { username: 'alice', role: 'admin' });
  assert.equal(await verifyLogin(f, 'alice', 'wrong-pw'), null);
  assert.equal(await verifyLogin(f, 'ghost', 'secret-pw'), null);
});

test('addUser rejects duplicates and invalid arguments', async () => {
  const f = freshFile();
  await addUser(f, 'alice', 'user', 'pw');
  await assert.rejects(() => addUser(f, 'alice', 'user', 'pw'), /user exists/);
  await assert.rejects(() => addUser(f, '', 'user', 'pw'), /username must be a non-empty string/);
  await assert.rejects(() => addUser(f, 'bob', 'superadmin', 'pw'), /invalid role/);
});

test('setPassword updates the stored credential', async () => {
  const f = freshFile();
  await addUser(f, 'alice', 'user', 'old-pw');
  await setPassword(f, 'alice', 'new-pw');
  assert.ok(await verifyLogin(f, 'alice', 'new-pw'));
  assert.equal(await verifyLogin(f, 'alice', 'old-pw'), null);
  await assert.rejects(() => setPassword(f, 'ghost', 'pw'), /no such user/);
});

test('listUsers returns usernames and roles without password records', async () => {
  const f = freshFile();
  await addUser(f, 'alice', 'admin', 'pw');
  await addUser(f, 'bob', 'user', 'pw');
  assert.deepEqual(listUsers(f), [
    { username: 'alice', role: 'admin' },
    { username: 'bob', role: 'user' },
  ]);
});

test('loadUsers rejects malformed files', async (t) => {
  const cases = [
    { name: 'not JSON', raw: 'not json', err: /invalid JSON in users file/ },
    { name: 'no users array', raw: '{}', err: /must contain a "users" array/ },
    { name: 'users not an array', raw: '{"users":"x"}', err: /must contain a "users" array/ },
    { name: 'entry missing username', raw: '{"users":[{"role":"user","password":{}}]}', err: /missing username/ },
    { name: 'invalid role', raw: '{"users":[{"username":"a","role":"root","password":{}}]}', err: /invalid role/ },
    { name: 'no password record', raw: '{"users":[{"username":"a","role":"user"}]}', err: /no password record/ },
  ];
  for (const c of cases) {
    await t.test(c.name, () => {
      assert.throws(() => loadUsers(writeRaw(c.raw)), c.err);
    });
  }
});

test('loadUsers accepts an empty users array', () => {
  assert.deepEqual(loadUsers(writeRaw('{"users":[]}')), { users: [] });
});

test('loadUsers throws when the file is missing', () => {
  assert.throws(() => loadUsers(path.join(dir, 'no-such-file.json')), /cannot read users file/);
});
