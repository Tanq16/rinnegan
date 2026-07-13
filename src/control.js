export function createControl({ mode, staleControllerSeconds, requestTimeoutSeconds, persistMode }) {
  let controller = null;
  let pending = null;
  let listener = null;
  let staleTimer = null;
  let requestTimer = null;

  function emit(kind, data) {
    if (listener) listener(kind, data);
  }

  function clearStale() {
    if (staleTimer) {
      clearTimeout(staleTimer);
      staleTimer = null;
    }
  }

  function clearPending() {
    pending = null;
    if (requestTimer) {
      clearTimeout(requestTimer);
      requestTimer = null;
    }
  }

  // Vacating control promotes a pending requester (spec: no controller => requester
  // gets control immediately). Applies to release and stale timeout alike.
  function vacate() {
    clearStale();
    if (pending) {
      controller = pending;
      clearPending();
    } else {
      controller = null;
    }
  }

  function becomeController(username) {
    controller = username;
    clearStale();
    clearPending();
  }

  return {
    getState() {
      return { controller, mode, pending };
    },
    isController(username) {
      return controller !== null && controller === username;
    },
    take(username, isAdmin) {
      if (mode === 'soft' && !isAdmin && controller !== null && controller !== username) {
        return false;
      }
      const changed = controller !== username || pending !== null;
      becomeController(username);
      if (changed) emit('state');
      return true;
    },
    request(username) {
      if (controller === username) return;
      if (mode === 'fast' || controller === null) {
        becomeController(username);
        emit('state');
        return;
      }
      pending = username;
      if (requestTimer) clearTimeout(requestTimer);
      requestTimer = setTimeout(() => {
        requestTimer = null;
        pending = null;
        emit('state');
      }, requestTimeoutSeconds * 1000);
      emit('state');
      emit('request', { from: username });
    },
    grant(byUsername, to, isAdmin) {
      if (!isAdmin && byUsername !== controller) return false;
      if (pending === null || pending !== to) return false;
      becomeController(to);
      emit('state');
      return true;
    },
    deny(byUsername, isAdmin) {
      if (!isAdmin && byUsername !== controller) return;
      if (pending === null) return;
      clearPending();
      emit('state');
    },
    // requester withdrawing their own pending request (e.g. switching to a
    // split session); deny() is the controller-side refusal, this is self-cancel
    cancelRequest(username) {
      if (pending === null || pending !== username) return;
      clearPending();
      emit('state');
    },
    release(username, isAdmin) {
      if (controller === null) return;
      if (controller !== username && !isAdmin) return;
      vacate();
      emit('state');
    },
    setMode(m) {
      if (m === mode) return;
      mode = m;
      if (mode === 'fast') clearPending();
      persistMode(mode);
      emit('state');
    },
    // A reconnecting controller keeps the stale reservation only by actually
    // re-attaching to the shared session (called from returnToShared in ws.js).
    // Merely connecting parks the socket in the lobby, which holds no control
    // claim — the stale timer keeps running there and releases control on
    // schedule if the user never attaches.
    reattached(username) {
      if (controller === username) clearStale();
    },
    // spec First User Behavior, moved from connect to shared-attach: no
    // controller => the attaching user gets control. No emit here — ws.js
    // broadcasts state after the mode frame and replay.
    claimIfVacant(username) {
      if (controller !== null) return false;
      becomeController(username);
      return true;
    },
    disconnected(username) {
      if (controller === username) {
        clearStale();
        staleTimer = setTimeout(() => {
          staleTimer = null;
          vacate();
          emit('state');
        }, staleControllerSeconds * 1000);
      } else if (pending === username) {
        clearPending();
        emit('state');
      }
    },
    subscribe(fn) {
      listener = fn;
    },
  };
}
