(function exposeFocusTimer(global) {
  const ACTIVE_KEY = "sg.focus.timer.v1";
  const LAST_COMPLETED_KEY = "sg.focus.timer.last-completed.v1";
  const TARGETS = [15, 30, 45, 60];

  const read = (key) => {
    try { return JSON.parse(localStorage.getItem(key) || "null"); }
    catch (_) { return null; }
  };
  const write = (key, value) => localStorage.setItem(key, JSON.stringify(value));
  const newId = () => global.crypto?.randomUUID?.() || `focus-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  function normalize(raw, persist = true) {
    if (!raw || !TARGETS.includes(Number(raw.targetMinutes))) return null;
    const targetSeconds = Number(raw.targetMinutes) * 60;
    let elapsedSeconds = Math.max(0, Number(raw.accumulatedBeforeRunSeconds || 0));
    if (raw.status === "running" && raw.startedAtMs) elapsedSeconds += Math.max(0, (Date.now() - Number(raw.startedAtMs)) / 1000);
    elapsedSeconds = Math.min(targetSeconds, elapsedSeconds);
    if (elapsedSeconds >= targetSeconds && raw.status !== "cancelled") {
      raw.status = "completed";
      raw.accumulatedBeforeRunSeconds = targetSeconds;
      raw.startedAtMs = null;
      raw.completedAtMs = raw.completedAtMs || Date.now();
      if (persist) {
        write(ACTIVE_KEY, raw);
        write(LAST_COMPLETED_KEY, raw);
      }
    }
    return {
      timerId: String(raw.timerId),
      status: raw.status,
      targetMinutes: Number(raw.targetMinutes),
      elapsedSeconds,
      remainingSeconds: Math.max(0, targetSeconds - elapsedSeconds),
      startedAtMs: raw.startedAtMs ? Number(raw.startedAtMs) : null,
      accumulatedBeforeRunSeconds: Number(raw.accumulatedBeforeRunSeconds || 0),
      completedAtMs: raw.completedAtMs ? Number(raw.completedAtMs) : null,
    };
  }

  function start(targetMinutes) {
    const target = Number(targetMinutes);
    if (!TARGETS.includes(target)) throw new Error("专注时长只支持 15、30、45 或 60 分钟");
    const raw = {
      timerId: newId(), status: "running", targetMinutes: target, startedAtMs: Date.now(),
      accumulatedBeforeRunSeconds: 0, completedAtMs: null,
    };
    write(ACTIVE_KEY, raw);
    return normalize(raw, false);
  }

  function pause() {
    const raw = read(ACTIVE_KEY);
    const current = normalize(raw);
    if (!current || current.status !== "running") return current;
    raw.accumulatedBeforeRunSeconds = current.elapsedSeconds;
    raw.startedAtMs = null;
    raw.status = "paused";
    write(ACTIVE_KEY, raw);
    return normalize(raw, false);
  }

  function resume() {
    const raw = read(ACTIVE_KEY);
    const current = normalize(raw);
    if (!current || current.status === "completed") return current;
    raw.accumulatedBeforeRunSeconds = current.elapsedSeconds;
    raw.startedAtMs = Date.now();
    raw.status = "running";
    write(ACTIVE_KEY, raw);
    return normalize(raw, false);
  }

  function cancel() {
    const current = normalize(read(ACTIVE_KEY));
    localStorage.removeItem(ACTIVE_KEY);
    return current ? { ...current, status: "cancelled" } : null;
  }

  function finishCompleted() {
    const current = normalize(read(ACTIVE_KEY));
    if (current?.status === "completed") localStorage.removeItem(ACTIVE_KEY);
    return current;
  }

  function clearLegacy() {
    localStorage.removeItem("sg.mock.focus.v2");
  }

  clearLegacy();
  global.SpineGuardFocusTimer = {
    TARGETS,
    start,
    pause,
    resume,
    cancel,
    finishCompleted,
    current: () => normalize(read(ACTIVE_KEY)),
    lastCompleted: () => normalize(read(LAST_COMPLETED_KEY), false),
  };
})(window);
