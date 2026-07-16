import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createControl } from '../src/control.js';

// Every subtest enables mock timers on its own context: soft-mode request() and controller disconnect() arm long real setTimeouts that would otherwise dangle and keep the process alive after the assertions finish.
function useTimers(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
}

function makeControl(overrides = {}) {
  const events = [];
  const persisted = [];
  const c = createControl({
    mode: 'soft',
    staleControllerSeconds: 100,
    requestTimeoutSeconds: 50,
    persistMode: (m) => persisted.push(m),
    ...overrides,
  });
  c.subscribe((kind, data) => events.push({ kind, data }));
  return { c, events, persisted };
}

const kinds = (events) => events.map((e) => e.kind);

test('take', async (t) => {
  await t.test('claims control when vacant and emits once', (t) => {
    useTimers(t);
    const { c, events } = makeControl();
    assert.equal(c.take('alice', false), true);
    assert.equal(c.getState().controller, 'alice');
    assert.deepEqual(kinds(events), ['state']);
  });

  await t.test('is idempotent for the current controller', (t) => {
    useTimers(t);
    const { c, events } = makeControl();
    c.take('alice', false);
    events.length = 0;
    assert.equal(c.take('alice', false), true);
    assert.deepEqual(events, []);
  });

  await t.test('non-admin cannot steal in soft mode', (t) => {
    useTimers(t);
    const { c, events } = makeControl();
    c.take('alice', false);
    events.length = 0;
    assert.equal(c.take('bob', false), false);
    assert.equal(c.getState().controller, 'alice');
    assert.deepEqual(events, []);
  });

  await t.test('admin overrides the current controller in soft mode', (t) => {
    useTimers(t);
    const { c } = makeControl();
    c.take('alice', false);
    assert.equal(c.take('bob', true), true);
    assert.equal(c.getState().controller, 'bob');
  });

  await t.test('any user steals in fast mode', (t) => {
    useTimers(t);
    const { c } = makeControl({ mode: 'fast' });
    c.take('alice', false);
    assert.equal(c.take('bob', false), true);
    assert.equal(c.getState().controller, 'bob');
  });

  await t.test('taking clears a pending request', (t) => {
    useTimers(t);
    const { c } = makeControl();
    c.take('alice', false);
    c.request('bob');
    assert.equal(c.getState().pending, 'bob');
    c.take('alice', false);
    assert.equal(c.getState().pending, null);
  });
});

test('request', async (t) => {
  await t.test('grants control immediately when vacant', (t) => {
    useTimers(t);
    const { c, events } = makeControl();
    c.request('alice');
    assert.equal(c.getState().controller, 'alice');
    assert.deepEqual(kinds(events), ['state']);
  });

  await t.test('is a no-op for the current controller', (t) => {
    useTimers(t);
    const { c, events } = makeControl();
    c.take('alice', false);
    events.length = 0;
    c.request('alice');
    assert.deepEqual(events, []);
  });

  await t.test('parks a pending request in soft mode and emits state + request', (t) => {
    useTimers(t);
    const { c, events } = makeControl();
    c.take('alice', false);
    events.length = 0;
    c.request('bob');
    assert.equal(c.getState().controller, 'alice');
    assert.equal(c.getState().pending, 'bob');
    assert.deepEqual(kinds(events), ['state', 'request']);
    assert.deepEqual(events.at(-1).data, { from: 'bob' });
  });

  await t.test('steals control in fast mode with no pending', (t) => {
    useTimers(t);
    const { c } = makeControl({ mode: 'fast' });
    c.take('alice', false);
    c.request('bob');
    assert.equal(c.getState().controller, 'bob');
    assert.equal(c.getState().pending, null);
  });

  await t.test('expires a pending request after the timeout', (t) => {
    useTimers(t);
    const { c, events } = makeControl({ requestTimeoutSeconds: 50 });
    c.take('alice', false);
    c.request('bob');
    events.length = 0;
    t.mock.timers.tick(50 * 1000);
    assert.equal(c.getState().pending, null);
    assert.equal(c.getState().controller, 'alice');
    assert.deepEqual(kinds(events), ['state']);
  });

  await t.test('a second request resets the timeout without firing the first', (t) => {
    useTimers(t);
    const { c } = makeControl({ requestTimeoutSeconds: 50 });
    c.take('alice', false);
    c.request('bob');
    t.mock.timers.tick(40 * 1000);
    c.request('carol');
    t.mock.timers.tick(40 * 1000);
    assert.equal(c.getState().pending, 'carol');
    t.mock.timers.tick(10 * 1000);
    assert.equal(c.getState().pending, null);
  });
});

test('grant', async (t) => {
  await t.test('controller grants to the pending user', (t) => {
    useTimers(t);
    const { c, events } = makeControl();
    c.take('alice', false);
    c.request('bob');
    events.length = 0;
    assert.equal(c.grant('alice', 'bob', false), true);
    assert.equal(c.getState().controller, 'bob');
    assert.equal(c.getState().pending, null);
    assert.deepEqual(kinds(events), ['state']);
  });

  await t.test('non-controller non-admin cannot grant', (t) => {
    useTimers(t);
    const { c } = makeControl();
    c.take('alice', false);
    c.request('bob');
    assert.equal(c.grant('mallory', 'bob', false), false);
    assert.equal(c.getState().controller, 'alice');
  });

  await t.test('admin can grant without being controller', (t) => {
    useTimers(t);
    const { c } = makeControl();
    c.take('alice', false);
    c.request('bob');
    assert.equal(c.grant('root', 'bob', true), true);
    assert.equal(c.getState().controller, 'bob');
  });

  await t.test('fails when there is no matching pending user', (t) => {
    useTimers(t);
    const { c } = makeControl();
    c.take('alice', false);
    assert.equal(c.grant('alice', 'bob', false), false);
    c.request('bob');
    assert.equal(c.grant('alice', 'carol', false), false);
    assert.equal(c.getState().controller, 'alice');
  });
});

test('deny', async (t) => {
  await t.test('controller clears the pending request', (t) => {
    useTimers(t);
    const { c, events } = makeControl();
    c.take('alice', false);
    c.request('bob');
    events.length = 0;
    c.deny('alice', false);
    assert.equal(c.getState().pending, null);
    assert.deepEqual(kinds(events), ['state']);
  });

  await t.test('non-controller non-admin cannot deny', (t) => {
    useTimers(t);
    const { c, events } = makeControl();
    c.take('alice', false);
    c.request('bob');
    events.length = 0;
    c.deny('mallory', false);
    assert.equal(c.getState().pending, 'bob');
    assert.deepEqual(events, []);
  });

  await t.test('admin can deny', (t) => {
    useTimers(t);
    const { c } = makeControl();
    c.take('alice', false);
    c.request('bob');
    c.deny('root', true);
    assert.equal(c.getState().pending, null);
  });

  await t.test('is a no-op when there is no pending request', (t) => {
    useTimers(t);
    const { c, events } = makeControl();
    c.take('alice', false);
    events.length = 0;
    c.deny('alice', false);
    assert.deepEqual(events, []);
  });
});

test('cancelRequest', async (t) => {
  await t.test('requester cancels their own pending request', (t) => {
    useTimers(t);
    const { c, events } = makeControl();
    c.take('alice', false);
    c.request('bob');
    events.length = 0;
    c.cancelRequest('bob');
    assert.equal(c.getState().pending, null);
    assert.deepEqual(kinds(events), ['state']);
  });

  await t.test('a non-pending user cannot cancel', (t) => {
    useTimers(t);
    const { c, events } = makeControl();
    c.take('alice', false);
    c.request('bob');
    events.length = 0;
    c.cancelRequest('carol');
    assert.equal(c.getState().pending, 'bob');
    assert.deepEqual(events, []);
  });
});

test('release', async (t) => {
  await t.test('controller releases to vacant when no pending', (t) => {
    useTimers(t);
    const { c, events } = makeControl();
    c.take('alice', false);
    events.length = 0;
    c.release('alice', false);
    assert.equal(c.getState().controller, null);
    assert.deepEqual(kinds(events), ['state']);
  });

  await t.test('releasing promotes a pending requester', (t) => {
    useTimers(t);
    const { c } = makeControl();
    c.take('alice', false);
    c.request('bob');
    c.release('alice', false);
    assert.equal(c.getState().controller, 'bob');
    assert.equal(c.getState().pending, null);
  });

  await t.test('non-controller non-admin cannot release', (t) => {
    useTimers(t);
    const { c, events } = makeControl();
    c.take('alice', false);
    events.length = 0;
    c.release('bob', false);
    assert.equal(c.getState().controller, 'alice');
    assert.deepEqual(events, []);
  });

  await t.test('admin can release someone else', (t) => {
    useTimers(t);
    const { c } = makeControl();
    c.take('alice', false);
    c.release('root', true);
    assert.equal(c.getState().controller, null);
  });

  await t.test('is a no-op when no controller exists', (t) => {
    useTimers(t);
    const { c, events } = makeControl();
    c.release('alice', false);
    assert.deepEqual(events, []);
  });
});

test('setMode', async (t) => {
  await t.test('setting the same mode is a no-op', (t) => {
    useTimers(t);
    const { c, events, persisted } = makeControl({ mode: 'soft' });
    c.setMode('soft');
    assert.deepEqual(events, []);
    assert.deepEqual(persisted, []);
  });

  await t.test('switching to fast persists, clears pending, and emits', (t) => {
    useTimers(t);
    const { c, events, persisted } = makeControl({ mode: 'soft' });
    c.take('alice', false);
    c.request('bob');
    events.length = 0;
    c.setMode('fast');
    assert.equal(c.getState().mode, 'fast');
    assert.equal(c.getState().pending, null);
    assert.deepEqual(persisted, ['fast']);
    assert.deepEqual(kinds(events), ['state']);
  });

  await t.test('switching back to soft persists and emits', (t) => {
    useTimers(t);
    const { c, persisted } = makeControl({ mode: 'fast' });
    c.setMode('soft');
    assert.equal(c.getState().mode, 'soft');
    assert.deepEqual(persisted, ['soft']);
  });
});

test('claimIfVacant', async (t) => {
  await t.test('claims silently when vacant', (t) => {
    useTimers(t);
    const { c, events } = makeControl();
    assert.equal(c.claimIfVacant('alice'), true);
    assert.equal(c.getState().controller, 'alice');
    assert.deepEqual(events, []);
  });

  await t.test('refuses when a controller is present', (t) => {
    useTimers(t);
    const { c } = makeControl();
    c.take('alice', false);
    assert.equal(c.claimIfVacant('bob'), false);
    assert.equal(c.getState().controller, 'alice');
  });
});

test('disconnected', async (t) => {
  await t.test('controller disconnect vacates after the stale timeout', (t) => {
    useTimers(t);
    const { c, events } = makeControl({ staleControllerSeconds: 100 });
    c.take('alice', false);
    events.length = 0;
    c.disconnected('alice');
    assert.equal(c.getState().controller, 'alice');
    assert.deepEqual(events, []);
    t.mock.timers.tick(100 * 1000);
    assert.equal(c.getState().controller, null);
    assert.deepEqual(kinds(events), ['state']);
  });

  await t.test('stale expiry promotes a pending requester', (t) => {
    useTimers(t);
    const { c } = makeControl({ staleControllerSeconds: 100, requestTimeoutSeconds: 10000 });
    c.take('alice', false);
    c.request('bob');
    c.disconnected('alice');
    t.mock.timers.tick(100 * 1000);
    assert.equal(c.getState().controller, 'bob');
    assert.equal(c.getState().pending, null);
  });

  await t.test('pending user disconnect clears the request immediately', (t) => {
    useTimers(t);
    const { c, events } = makeControl();
    c.take('alice', false);
    c.request('bob');
    events.length = 0;
    c.disconnected('bob');
    assert.equal(c.getState().pending, null);
    assert.deepEqual(kinds(events), ['state']);
  });

  await t.test('an unrelated user disconnect is a no-op', (t) => {
    useTimers(t);
    const { c, events } = makeControl();
    c.take('alice', false);
    events.length = 0;
    c.disconnected('carol');
    assert.equal(c.getState().controller, 'alice');
    assert.deepEqual(events, []);
  });
});

test('reattached', async (t) => {
  await t.test('the controller reattaching cancels the stale vacate', (t) => {
    useTimers(t);
    const { c, events } = makeControl({ staleControllerSeconds: 100 });
    c.take('alice', false);
    c.disconnected('alice');
    c.reattached('alice');
    events.length = 0;
    t.mock.timers.tick(100 * 1000);
    assert.equal(c.getState().controller, 'alice');
    assert.deepEqual(events, []);
  });

  await t.test('a different user reattaching leaves the stale timer running', (t) => {
    useTimers(t);
    const { c } = makeControl({ staleControllerSeconds: 100 });
    c.take('alice', false);
    c.disconnected('alice');
    c.reattached('bob');
    t.mock.timers.tick(100 * 1000);
    assert.equal(c.getState().controller, null);
  });
});

test('isController reflects the current controller', (t) => {
  useTimers(t);
  const { c } = makeControl();
  assert.equal(c.isController('alice'), false);
  c.take('alice', false);
  assert.equal(c.isController('alice'), true);
  assert.equal(c.isController('bob'), false);
});
