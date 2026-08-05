import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSocket, evaluateSocketSafe, refreshMeta, refreshSockets } from '../src/ws.js';

const NOW = 1_000_000_000_000; // fixed ms so nowSec and the STALE/GRACE math are exact
const nowSec = Math.floor(NOW / 1000);
const TTL = 10800;
const FP = 'Zm9vYmFyMTIzNDU2';
const WEEK = 7 * 24 * 3600;
const makeMeta = (over = {}) => ({ fp: FP, lastSeen: NOW, deadline: nowSec + 1000, sessionExp: nowSec + WEEK, credentialFailures: 0, ...over });
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
    const meta = makeMeta({ fp: null, deadline: Infinity });
    assert.equal(evaluateSocket(meta, NOW, notCalled, TTL), 'ping');
    assert.equal(meta.deadline, Infinity);
  });

  await t.test('past deadline with an unchanged credential slides', () => {
    const meta = makeMeta({ deadline: nowSec - 100 });
    assert.equal(evaluateSocket(meta, NOW, same, TTL), 'slide');
    assert.equal(meta.deadline, (nowSec - 100) + TTL);
  });

  await t.test('an expired session closes and leaves meta untouched', () => {
    const meta = makeMeta({ deadline: nowSec - 100, sessionExp: nowSec - 1 });
    assert.equal(evaluateSocket(meta, NOW, same, TTL), 'close');
    assert.equal(meta.deadline, nowSec - 100, 'a close must not slide the deadline');
  });

  await t.test('the session boundary is inclusive: one second short still slides, reaching it closes', () => {
    const short = makeMeta({ deadline: nowSec - 100, sessionExp: nowSec + 1 });
    assert.equal(evaluateSocket(short, NOW, same, TTL), 'slide');

    const reached = makeMeta({ deadline: nowSec - 100, sessionExp: nowSec });
    assert.equal(evaluateSocket(reached, NOW, same, TTL), 'close');
  });

  await t.test('a rotated password closes even while the session is still live', () => {
    const meta = makeMeta({ deadline: nowSec - 100 });
    assert.equal(evaluateSocket(meta, NOW, rotated, TTL), 'close');
    assert.equal(meta.deadline, nowSec - 100);
  });

  await t.test('stale takes precedence over an expired deadline', () => {
    const meta = makeMeta({ lastSeen: NOW - 90001, deadline: nowSec - 100 });
    assert.equal(evaluateSocket(meta, NOW, notCalled, TTL), 'terminate');
  });

  await t.test('the grace boundary is inclusive: deadline+GRACE still pings, one second past slides', () => {
    const atBoundary = makeMeta({ deadline: nowSec - 60 }); // nowSec === deadline + GRACE_SECONDS
    assert.equal(evaluateSocket(atBoundary, NOW, notCalled, TTL), 'ping');

    const pastBoundary = makeMeta({ deadline: nowSec - 61 });
    assert.equal(evaluateSocket(pastBoundary, NOW, same, TTL), 'slide');
  });

  await t.test('a throwing credential read propagates and mutates nothing', () => {
    const meta = makeMeta({ deadline: nowSec - 100 });
    assert.throws(() => evaluateSocket(meta, NOW, () => { throw new Error('boom'); }, TTL));
    assert.equal(meta.deadline, nowSec - 100, 'a thrown credential read must not slide the deadline');
  });
});

test('session lifetime', async (t) => {
  const PING_MS = 25000;
  const GRACE = 60;
  const drive = (meta, fromMs, forHours, fp = same) => {
    const slides = [];
    for (let d = 0; d <= forHours * 3600 * 1000; d += PING_MS) {
      const now = fromMs + d;
      meta.lastSeen = now; // protocol pongs keep liveness fresh; the deadline alone is under test
      const action = evaluateSocket(meta, now, fp, TTL);
      if (action === 'slide') slides.push(Math.floor(now / 1000));
      if (action === 'close') return { slides, closedAt: Math.floor(now / 1000) };
    }
    return { slides, closedAt: null };
  };

  await t.test('a live socket that never refreshes survives well past the old 15h fuse', () => {
    const meta = makeMeta({ deadline: nowSec + TTL, sessionExp: nowSec + WEEK });
    const { slides, closedAt } = drive(meta, NOW, 24);

    assert.equal(closedAt, null, 'liveness alone must carry a socket through a full day without a single refresh');
    assert.ok(slides.length > 4, `the old budget was 4 slides; got ${slides.length}`);
  });

  await t.test('a live socket closes when the refresh token behind it finally expires', () => {
    const meta = makeMeta({ deadline: nowSec + TTL, sessionExp: nowSec + WEEK });
    const { closedAt } = drive(meta, NOW, 7 * 24 + 4);

    assert.notEqual(closedAt, null, 'the session must still end at the refresh cookie lifetime');
    const want = nowSec + WEEK;
    assert.ok(
      closedAt >= want && closedAt < want + TTL + GRACE + PING_MS / 1000,
      `close must land at the first credential check past sessionExp: got ${closedAt - want}s after it`
    );
  });

  await t.test('a rotated password closes a socket the session lifetime would otherwise have carried', () => {
    const meta = makeMeta({ deadline: nowSec + TTL, sessionExp: nowSec + WEEK });
    const { closedAt } = drive(meta, NOW, 24, rotated);
    assert.notEqual(closedAt, null, 'rotation must outrank a still-live session');
  });
});

test('refreshMeta sets the deadline', () => {
  const meta = { deadline: 1 };
  refreshMeta(meta, 999);
  assert.equal(meta.deadline, 999);
});

test('evaluateSocketSafe', async (t) => {
  const boom = () => { throw new Error('auth file gone'); };

  await t.test('a momentary credential-read failure degrades to ping without sliding', () => {
    const meta = makeMeta({ deadline: nowSec - 100 });
    assert.equal(evaluateSocketSafe(meta, NOW, boom, TTL), 'ping');
    assert.equal(meta.deadline, nowSec - 100, 'a swallowed credential failure must not slide the deadline');
    assert.equal(meta.credentialFailures, 1, 'the failure must count toward the fail-closed bound');
  });

  // The revocation gap: a deleted/corrupt auth file makes currentFingerprint throw every sweep; without a bound a past-deadline socket pinged forever and never closed.
  await t.test('a persistent credential-read failure fails closed at the bound instead of pinging forever', () => {
    const meta = makeMeta({ deadline: nowSec - 100 });
    const actions = Array.from({ length: 6 }, () => evaluateSocketSafe(meta, NOW, boom, TTL));
    assert.deepEqual(actions, ['ping', 'ping', 'ping', 'close', 'close', 'close']);
    assert.equal(meta.deadline, nowSec - 100, 'the fail-closed path must not slide the deadline');
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
    assert.equal(meta.deadline, (nowSec - 100) + TTL);
  });
});

const ROTATED = rotated();

test('refreshSockets', async (t) => {
  await t.test('re-arms every socket on the refreshed credential', () => {
    const metas = [
      { fp: FP, deadline: 1 },
      { fp: FP, deadline: 2 },
    ];
    refreshSockets(new Map(metas.map((m, i) => [`ws-${i}`, m])), FP, 999);
    for (const m of metas) assert.equal(m.deadline, 999);
  });

  await t.test('leaves a rotated-out socket untouched', () => {
    const meta = { fp: ROTATED, deadline: 2 };
    refreshSockets(new Map([['ws-0', meta]]), FP, 999);
    assert.deepEqual(meta, { fp: ROTATED, deadline: 2 });
  });

  // The revocation path: without the fp filter another session's refresh slides this deadline forever and the sweep never reaches the fingerprint check.
  await t.test('a rotated-out socket still closes after someone else refreshes', () => {
    const meta = makeMeta({ fp: ROTATED, deadline: nowSec - 61 });
    refreshSockets(new Map([['ws-0', meta]]), FP, nowSec + TTL);
    assert.equal(evaluateSocket(meta, NOW, same, TTL), 'close');
  });
});
