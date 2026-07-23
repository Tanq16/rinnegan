import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSocket, evaluateSocketSafe, refreshMeta, refreshUserSockets } from '../src/ws.js';

const NOW = 1_000_000_000_000; // fixed ms so nowSec and the STALE/GRACE math are exact
const nowSec = Math.floor(NOW / 1000);
const TTL = 10800;
const makeMeta = (over = {}) => ({ username: 'alice', role: 'user', lastSeen: NOW, deadline: nowSec + 1000, missedRefreshes: 0, ...over });
const present = () => ({ username: 'alice', role: 'user' });
const notCalled = () => { throw new Error('findUser must not be called'); };

test('evaluateSocket', async (t) => {
  await t.test('stale socket terminates without touching the roster', () => {
    const meta = makeMeta({ lastSeen: NOW - 90001 });
    assert.equal(evaluateSocket(meta, NOW, notCalled, TTL), 'terminate');
  });

  await t.test('the stale boundary is exclusive: exactly STALE_MS still pings, one ms past terminates', () => {
    const atBoundary = makeMeta({ lastSeen: NOW - 90000 }); // nowMs - lastSeen === STALE_MS
    assert.equal(evaluateSocket(atBoundary, NOW, notCalled, TTL), 'ping');
    const pastBoundary = makeMeta({ lastSeen: NOW - 90001 });
    assert.equal(evaluateSocket(pastBoundary, NOW, notCalled, TTL), 'terminate');
  });

  await t.test('live socket pings without touching the roster', () => {
    const meta = makeMeta({ deadline: nowSec + 1000 });
    assert.equal(evaluateSocket(meta, NOW, notCalled, TTL), 'ping');
  });

  await t.test('Infinity deadline (no-auth) never enters the slide branch', () => {
    const meta = makeMeta({ deadline: Infinity, role: 'admin', missedRefreshes: 0 });
    assert.equal(evaluateSocket(meta, NOW, notCalled, TTL), 'ping');
    assert.equal(meta.deadline, Infinity);
    assert.equal(meta.missedRefreshes, 0);
    assert.equal(meta.role, 'admin');
  });

  await t.test('past deadline with a valid user slides and re-applies the current role', () => {
    const meta = makeMeta({ deadline: nowSec - 100, role: 'admin', missedRefreshes: 0 });
    assert.equal(evaluateSocket(meta, NOW, () => ({ username: 'alice', role: 'user' }), TTL), 'slide');
    assert.equal(meta.deadline, (nowSec - 100) + TTL);
    assert.equal(meta.missedRefreshes, 1);
    assert.equal(meta.role, 'user', 'a demotion must land on the slide');
  });

  await t.test('counter exhaustion closes and leaves meta untouched', () => {
    const meta = makeMeta({ deadline: nowSec - 100, missedRefreshes: 4 });
    assert.equal(evaluateSocket(meta, NOW, present, TTL), 'close');
    assert.equal(meta.deadline, nowSec - 100, 'a close must not slide the deadline');
    assert.equal(meta.missedRefreshes, 4, 'a close must not bump the counter');
  });

  await t.test('the counter boundary is inclusive: 3 still slides up to the close threshold of 4', () => {
    const meta = makeMeta({ deadline: nowSec - 100, missedRefreshes: 3 });
    assert.equal(evaluateSocket(meta, NOW, present, TTL), 'slide');
    assert.equal(meta.missedRefreshes, 4, 'the largest still-sliding counter must bump to the close threshold');
    assert.equal(meta.deadline, (nowSec - 100) + TTL);
  });

  await t.test('a deleted user closes and leaves meta untouched', () => {
    const meta = makeMeta({ deadline: nowSec - 100, missedRefreshes: 0 });
    assert.equal(evaluateSocket(meta, NOW, () => null, TTL), 'close');
    assert.equal(meta.missedRefreshes, 0);
    assert.equal(meta.deadline, nowSec - 100);
  });

  await t.test('stale takes precedence over an expired deadline', () => {
    const meta = makeMeta({ lastSeen: NOW - 90001, deadline: nowSec - 100 });
    assert.equal(evaluateSocket(meta, NOW, notCalled, TTL), 'terminate');
  });

  await t.test('the grace boundary is inclusive: deadline+GRACE still pings, one second past slides', () => {
    const atBoundary = makeMeta({ deadline: nowSec - 60 }); // nowSec === deadline + GRACE_SECONDS
    assert.equal(evaluateSocket(atBoundary, NOW, notCalled, TTL), 'ping');

    const pastBoundary = makeMeta({ deadline: nowSec - 61, missedRefreshes: 0 });
    assert.equal(evaluateSocket(pastBoundary, NOW, present, TTL), 'slide');
  });

  await t.test('a throwing findUser propagates and mutates nothing', () => {
    const meta = makeMeta({ deadline: nowSec - 100 });
    assert.throws(() => evaluateSocket(meta, NOW, () => { throw new Error('boom'); }, TTL));
    assert.equal(meta.deadline, nowSec - 100, 'a thrown roster read must not slide the deadline');
    assert.equal(meta.missedRefreshes, 0, 'a thrown roster read must not bump the counter');
  });
});

test('refreshMeta', async (t) => {
  await t.test('resets the counter and sets the deadline and role', () => {
    const meta = { deadline: 1, missedRefreshes: 3, role: 'user' };
    refreshMeta(meta, 999, 'admin');
    assert.equal(meta.deadline, 999);
    assert.equal(meta.missedRefreshes, 0);
    assert.equal(meta.role, 'admin');
  });

  await t.test('an undefined role leaves the existing role in place', () => {
    const meta = { deadline: 1, missedRefreshes: 2, role: 'user' };
    refreshMeta(meta, 999);
    assert.equal(meta.role, 'user');
    assert.equal(meta.missedRefreshes, 0);
    assert.equal(meta.deadline, 999);
  });
});

test('evaluateSocketSafe', async (t) => {
  await t.test('degrades a roster-read failure to ping and mutates nothing (never closes)', () => {
    const meta = makeMeta({ deadline: nowSec - 100 });
    assert.equal(evaluateSocketSafe(meta, NOW, () => { throw new Error('boom'); }, TTL), 'ping');
    assert.equal(meta.deadline, nowSec - 100, 'a swallowed roster failure must not slide the deadline');
    assert.equal(meta.missedRefreshes, 0, 'a swallowed roster failure must not bump the counter');
  });

  await t.test('forwards a normal decision unchanged', () => {
    const meta = makeMeta({ deadline: nowSec - 100 });
    assert.equal(evaluateSocketSafe(meta, NOW, present, TTL), 'slide');
    assert.equal(meta.missedRefreshes, 1);
  });
});

test('refreshUserSockets', async (t) => {
  await t.test('resets only the matching user\'s sockets, leaving other users untouched', () => {
    const a1 = { username: 'alice', deadline: 1, missedRefreshes: 3, role: 'user' };
    const a2 = { username: 'alice', deadline: 1, missedRefreshes: 2, role: 'user' };
    const bob = { username: 'bob', deadline: 1, missedRefreshes: 3, role: 'user' };
    const sockets = new Map([['ws-a1', a1], ['ws-a2', a2], ['ws-bob', bob]]);
    refreshUserSockets(sockets, 'alice', 999, 'admin');
    for (const m of [a1, a2]) {
      assert.equal(m.deadline, 999);
      assert.equal(m.missedRefreshes, 0);
      assert.equal(m.role, 'admin');
    }
    assert.equal(bob.missedRefreshes, 3, 'another user\'s counter must not reset on a refresh');
    assert.equal(bob.deadline, 1, 'another user\'s deadline must not slide');
    assert.equal(bob.role, 'user', 'another user\'s role must not change');
  });
});
