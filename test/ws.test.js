import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSocket, evaluateSocketSafe, refreshMeta, refreshSockets } from '../src/ws.js';

const NOW = 1_000_000_000_000; // fixed ms so nowSec and the STALE/GRACE math are exact
const nowSec = Math.floor(NOW / 1000);
const TTL = 10800;
const FP = 'Zm9vYmFyMTIzNDU2';
const makeMeta = (over = {}) => ({ fp: FP, lastSeen: NOW, deadline: nowSec + 1000, missedRefreshes: 0, credentialFailures: 0, ...over });
const same = () => FP;
const rotated = () => 'cm90YXRlZDEyMzQ1';
const notCalled = () => { throw new Error('currentFingerprint must not be called'); };

test('evaluateSocket', async (t) => {
  await t.test('stale socket terminates without reading the credential', () => {
    const meta = makeMeta({ lastSeen: NOW - 90001 });
    assert.equal(evaluateSocket(meta, NOW, notCalled, TTL), 'terminate');
  });

  await t.test('the stale boundary is exclusive: exactly STALE_MS still pings, one ms past terminates', () => {
    const atBoundary = makeMeta({ lastSeen: NOW - 90000 }); // nowMs - lastSeen === STALE_MS
    assert.equal(evaluateSocket(atBoundary, NOW, notCalled, TTL), 'ping');
    const pastBoundary = makeMeta({ lastSeen: NOW - 90001 });
    assert.equal(evaluateSocket(pastBoundary, NOW, notCalled, TTL), 'terminate');
  });

  await t.test('live socket pings without reading the credential', () => {
    const meta = makeMeta({ deadline: nowSec + 1000 });
    assert.equal(evaluateSocket(meta, NOW, notCalled, TTL), 'ping');
  });

  await t.test('Infinity deadline (no-auth) never enters the slide branch', () => {
    const meta = makeMeta({ fp: null, deadline: Infinity, missedRefreshes: 0 });
    assert.equal(evaluateSocket(meta, NOW, notCalled, TTL), 'ping');
    assert.equal(meta.deadline, Infinity);
    assert.equal(meta.missedRefreshes, 0);
  });

  await t.test('past deadline with an unchanged credential slides', () => {
    const meta = makeMeta({ deadline: nowSec - 100, missedRefreshes: 0 });
    assert.equal(evaluateSocket(meta, NOW, same, TTL), 'slide');
    assert.equal(meta.deadline, (nowSec - 100) + TTL);
    assert.equal(meta.missedRefreshes, 1);
  });

  await t.test('counter exhaustion closes and leaves meta untouched', () => {
    const meta = makeMeta({ deadline: nowSec - 100, missedRefreshes: 4 });
    assert.equal(evaluateSocket(meta, NOW, same, TTL), 'close');
    assert.equal(meta.deadline, nowSec - 100, 'a close must not slide the deadline');
    assert.equal(meta.missedRefreshes, 4, 'a close must not bump the counter');
  });

  await t.test('the counter boundary is inclusive: 3 still slides up to the close threshold of 4', () => {
    const meta = makeMeta({ deadline: nowSec - 100, missedRefreshes: 3 });
    assert.equal(evaluateSocket(meta, NOW, same, TTL), 'slide');
    assert.equal(meta.missedRefreshes, 4, 'the largest still-sliding counter must bump to the close threshold');
    assert.equal(meta.deadline, (nowSec - 100) + TTL);
  });

  await t.test('a rotated password closes and leaves meta untouched', () => {
    const meta = makeMeta({ deadline: nowSec - 100, missedRefreshes: 0 });
    assert.equal(evaluateSocket(meta, NOW, rotated, TTL), 'close');
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
    assert.equal(evaluateSocket(pastBoundary, NOW, same, TTL), 'slide');
  });

  await t.test('a throwing credential read propagates and mutates nothing', () => {
    const meta = makeMeta({ deadline: nowSec - 100 });
    assert.throws(() => evaluateSocket(meta, NOW, () => { throw new Error('boom'); }, TTL));
    assert.equal(meta.deadline, nowSec - 100, 'a thrown credential read must not slide the deadline');
    assert.equal(meta.missedRefreshes, 0, 'a thrown credential read must not bump the counter');
  });
});

// The per-transition tests above pass for either a 12h or a 15h total budget; only the whole sweep pins which.
test('session fuse', async (t) => {
  const PING_MS = 25000;
  const GRACE = 60;
  const drive = (meta, fromMs, forHours) => {
    const slides = [];
    for (let d = 0; d <= forHours * 3600 * 1000; d += PING_MS) {
      const now = fromMs + d;
      meta.lastSeen = now; // protocol pongs keep liveness fresh; the deadline alone is under test
      const action = evaluateSocket(meta, now, same, TTL);
      if (action === 'slide') slides.push(Math.floor(now / 1000));
      if (action === 'close') return { slides, closedAt: Math.floor(now / 1000) };
    }
    return { slides, closedAt: null };
  };

  await t.test('an unrefreshed socket closes 4 slides after its deadline, not at the 12h ceiling', () => {
    const d0 = nowSec + TTL;
    const meta = makeMeta({ deadline: d0, missedRefreshes: 0 });
    const { slides, closedAt } = drive(meta, NOW, 20);

    assert.equal(slides.length, 4, 'the budget is exactly MAX_MISSED_REFRESHES slides');
    assert.equal(meta.deadline, d0 + 4 * TTL, 'every slide must have advanced the deadline by one TTL');
    assert.notEqual(closedAt, null, 'the fuse must actually burn out within 20h');
    const want = d0 + 4 * TTL + GRACE;
    assert.ok(
      closedAt >= want && closedAt < want + PING_MS / 1000,
      `close must land at the grace edge of the last slide: got ${closedAt - nowSec}s after connect, want ~${want - nowSec}s`
    );
    assert.equal(want - nowSec, 15 * 3600 + GRACE, 'total budget is 15h01m from connect, not the 12h of slide headroom');
  });

  await t.test('a refresh mid-fuse restores the full budget, so a live client never reaches the close', () => {
    const d0 = nowSec + TTL;
    const meta = makeMeta({ deadline: d0, missedRefreshes: 0 });
    drive(meta, NOW, 8);
    assert.ok(meta.missedRefreshes > 0, 'the socket must have burned budget before the refresh lands');

    const refreshedAtSec = nowSec + 8 * 3600;
    refreshMeta(meta, refreshedAtSec + TTL);
    assert.equal(meta.missedRefreshes, 0);

    const { closedAt } = drive(meta, refreshedAtSec * 1000, 14);
    assert.equal(closedAt, null, 'a refreshed socket must survive another 14h');
  });

  await t.test('a rotated password closes a socket that a refresh would otherwise have carried', () => {
    const meta = makeMeta({ deadline: nowSec - 100, missedRefreshes: 0 });
    assert.equal(evaluateSocket(meta, NOW, rotated, TTL), 'close');
  });
});

test('refreshMeta resets the counter and sets the deadline', () => {
  const meta = { deadline: 1, missedRefreshes: 3 };
  refreshMeta(meta, 999);
  assert.equal(meta.deadline, 999);
  assert.equal(meta.missedRefreshes, 0);
});

test('evaluateSocketSafe', async (t) => {
  const boom = () => { throw new Error('auth file gone'); };

  await t.test('a momentary credential-read failure degrades to ping without sliding or bumping the fuse', () => {
    const meta = makeMeta({ deadline: nowSec - 100 });
    assert.equal(evaluateSocketSafe(meta, NOW, boom, TTL), 'ping');
    assert.equal(meta.deadline, nowSec - 100, 'a swallowed credential failure must not slide the deadline');
    assert.equal(meta.missedRefreshes, 0, 'a swallowed credential failure must not bump the refresh counter');
    assert.equal(meta.credentialFailures, 1, 'the failure must count toward the fail-closed bound');
  });

  // The revocation gap: a deleted/corrupt auth file makes currentFingerprint throw every sweep; without a bound a past-deadline socket pinged forever and never closed.
  await t.test('a persistent credential-read failure fails closed at the bound instead of pinging forever', () => {
    const meta = makeMeta({ deadline: nowSec - 100 });
    const actions = Array.from({ length: 6 }, () => evaluateSocketSafe(meta, NOW, boom, TTL));
    assert.deepEqual(actions, ['ping', 'ping', 'ping', 'close', 'close', 'close']);
    assert.equal(meta.deadline, nowSec - 100, 'the fail-closed path must not slide the deadline');
    assert.equal(meta.missedRefreshes, 0, 'the fail-closed path must not bump the refresh counter');
  });

  await t.test('a completed read resets the count so an intermittent blip never accumulates to a close', () => {
    const meta = makeMeta({ deadline: nowSec - 100 });
    evaluateSocketSafe(meta, NOW, boom, TTL);
    evaluateSocketSafe(meta, NOW, boom, TTL);
    assert.equal(meta.credentialFailures, 2);
    assert.equal(evaluateSocketSafe(meta, NOW, same, TTL), 'slide');
    assert.equal(meta.credentialFailures, 0, 'a completed evaluation clears the failure count');
  });

  await t.test('forwards a normal decision unchanged', () => {
    const meta = makeMeta({ deadline: nowSec - 100 });
    assert.equal(evaluateSocketSafe(meta, NOW, same, TTL), 'slide');
    assert.equal(meta.missedRefreshes, 1);
  });
});

const ROTATED = rotated();

test('refreshSockets', async (t) => {
  await t.test('re-arms every socket on the refreshed credential', () => {
    const metas = [
      { fp: FP, deadline: 1, missedRefreshes: 3 },
      { fp: FP, deadline: 2, missedRefreshes: 0 },
    ];
    refreshSockets(new Map(metas.map((m, i) => [`ws-${i}`, m])), FP, 999);
    for (const m of metas) {
      assert.equal(m.deadline, 999);
      assert.equal(m.missedRefreshes, 0);
    }
  });

  await t.test('leaves a rotated-out socket untouched', () => {
    const meta = { fp: ROTATED, deadline: 2, missedRefreshes: 4 };
    refreshSockets(new Map([['ws-0', meta]]), FP, 999);
    assert.deepEqual(meta, { fp: ROTATED, deadline: 2, missedRefreshes: 4 });
  });

  // The revocation path: without the fp filter another session's refresh slides this deadline forever and the fuse never reaches the fingerprint check.
  await t.test('a rotated-out socket still closes after someone else refreshes', () => {
    const meta = makeMeta({ fp: ROTATED, deadline: nowSec - 61 });
    refreshSockets(new Map([['ws-0', meta]]), FP, nowSec + TTL);
    assert.equal(evaluateSocket(meta, NOW, same, TTL), 'close');
  });
});
