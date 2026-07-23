const config = require('../config/env');
const api = require('./api');
const { mapGarden } = require('../utils/mapTelemetry');

const GARDEN_KEY = 'spineGardenMockV2';
const FOCUS_KEY = 'spineFocusTimerV1';
const LAST_FOCUS_KEY = 'spineFocusTimerLastCompletedV1';
const LEGACY_FOCUS_KEY = 'spineFocusMockV2';
const FOCUS_TARGETS = [15, 30, 45, 60];
const STAGES = [['seed', 0], ['sprout', 100], ['sapling', 300], ['tree', 600], ['flower', 1000], ['fruit', 1500]];

function mode() {
  return wx.getStorageSync('dataMode') || config.mode || (config.useMock ? 'mock' : 'api');
}
function quickEnabled() {
  return mode() === 'mock' && (wx.getStorageSync('quickTest') === true || config.quickTest === true);
}
function studentId() {
  const student = wx.getStorageSync('currentStudent') || {};
  return student.student_id || '';
}
function idempotencyKey() {
  return `mini-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
function localDate() {
  const date = new Date(Date.now() + 8 * 3600000);
  return date.toISOString().slice(0, 10);
}
function stageFor(growth) {
  return STAGES.slice().reverse().find((item) => growth >= item[1])[0];
}
function defaults() {
  return {
    growth: 450, stage: 'sapling', resources: { sunshine: 18, water: 12, nutrient: 5 },
    today_normal_s: 24 * 60, continuous_normal_s: 12 * 60, reminder_count: 3, reminder_rate_30m: 3,
    instant_tree_state: 'normal', recovery_needed: false, rule_version: 'garden-v1', updated_at: new Date().toISOString(), daily_growth_granted: 0,
    daily_growth_remaining: 180, server_time: new Date().toISOString(),
    local_date: localDate(),
    tasks: [
      { task_id: 'daily_normal_30', title: '今日正确坐姿累计 30 分钟', progress: 24, target: 30, unit: '分钟', status: 'locked', reward: { sunshine: 0, water: 6, nutrient: 0 } },
      { task_id: 'continuous_25', title: '连续正确坐姿 25 分钟', progress: 12, target: 25, unit: '分钟', status: 'locked', reward: { sunshine: 3, water: 3, nutrient: 0 } },
      { task_id: 'daily_reminder_lt_5', title: '今日提醒少于 5 次', progress: 3, target: 5, unit: '次', status: 'locked', reward: { sunshine: 0, water: 0, nutrient: 3 } },
      { task_id: 'active_rest_after_60', title: '学习满 60 分钟后主动休息', progress: 0, target: 1, unit: '次', status: 'locked', reward: { sunshine: 2, water: 0, nutrient: 0 } }
    ]
  };
}
function load() {
  const stored = wx.getStorageSync(GARDEN_KEY);
  if (!stored) return defaults();
  if (stored.today_normal_s === undefined) stored.today_normal_s = Number(stored.today_normal_seconds || 0);
  if (stored.continuous_normal_s === undefined) stored.continuous_normal_s = Number(stored.continuous_normal_seconds || 0);
  delete stored.today_normal_seconds; delete stored.continuous_normal_seconds;
  const taskAliases = { daily_30: 'daily_normal_30', few_reminders: 'daily_reminder_lt_5', active_break: 'active_rest_after_60' };
  (stored.tasks || []).forEach((task) => { task.task_id = taskAliases[task.task_id] || task.task_id; });
  const raw = Object.assign(defaults(), stored, { resources: Object.assign({}, defaults().resources, stored.resources || {}) });
  if (raw.local_date !== localDate()) {
    const task = raw.tasks.find((item) => item.task_id === 'daily_reminder_lt_5');
    if (Number(raw.session_effective_measurement_s || 0) >= 1800 && Number(raw.reminder_count || 0) < 5 && task && task.status !== 'claimed') raw.resources.nutrient += 3;
    raw.local_date = localDate(); raw.today_normal_s = 0; raw.daily_growth_granted = 0; raw.daily_growth_remaining = 180; raw.session_normal_s = 0; raw.session_base_growth_granted = 0; raw.reminder_count = 0; raw.reminder_rate_30m = 0; raw.tasks = defaults().tasks;
  }
  return raw;
}
function focusId() {
  return `focus-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
function normalizeFocusTimer(raw, persist) {
  if (!raw || !FOCUS_TARGETS.includes(Number(raw.targetMinutes))) return null;
  const targetSeconds = Number(raw.targetMinutes) * 60;
  let elapsedSeconds = Math.max(0, Number(raw.accumulatedBeforeRunSeconds || 0));
  if (raw.status === 'running' && raw.startedAtMs) {
    elapsedSeconds += Math.max(0, (Date.now() - Number(raw.startedAtMs)) / 1000);
  }
  elapsedSeconds = Math.min(targetSeconds, elapsedSeconds);
  if (elapsedSeconds >= targetSeconds && raw.status !== 'cancelled') {
    raw.status = 'completed';
    raw.accumulatedBeforeRunSeconds = targetSeconds;
    raw.startedAtMs = null;
    raw.completedAtMs = raw.completedAtMs || Date.now();
    if (persist !== false) {
      wx.setStorageSync(FOCUS_KEY, raw);
      wx.setStorageSync(LAST_FOCUS_KEY, raw);
    }
  }
  return {
    timerId: String(raw.timerId || ''),
    status: raw.status,
    targetMinutes: Number(raw.targetMinutes),
    elapsedSeconds,
    remainingSeconds: Math.max(0, targetSeconds - elapsedSeconds),
    startedAtMs: raw.startedAtMs ? Number(raw.startedAtMs) : null,
    accumulatedBeforeRunSeconds: Number(raw.accumulatedBeforeRunSeconds || 0),
    completedAtMs: raw.completedAtMs ? Number(raw.completedAtMs) : null
  };
}
function save(raw) {
  raw.stage = stageFor(raw.growth);
  raw.updated_at = new Date().toISOString();
  raw.server_time = raw.updated_at;
  raw.daily_growth_remaining = Math.max(0, 180 - Number(raw.daily_growth_granted || 0));
  wx.setStorageSync(GARDEN_KEY, raw);
  return mapGarden(raw);
}
function path(suffix) {
  const id = studentId();
  if (!id) throw new Error('请先登录并选择学生');
  return `/students/${encodeURIComponent(id)}${suffix}`;
}
function requestGarden(options) {
  return api.request(options).then((payload) => mapGarden(payload.data));
}

function getGarden() {
  return mode() === 'mock' ? Promise.resolve(mapGarden(load())) : requestGarden({ path: path('/garden') });
}
function recordTelemetry(telemetry) {
  if (mode() !== 'mock') return Promise.resolve(null);
  const raw = load();
  const sameSession = raw.last_device_session_id === telemetry.deviceSessionId;
  if (sameSession && Number(telemetry.sequence) <= Number(raw.last_sequence === undefined ? -1 : raw.last_sequence)) return Promise.resolve(mapGarden(raw));
  const delta = sameSession ? Math.max(0, Math.min(10, (telemetry.recordedAt - Number(raw.last_recorded_at || telemetry.recordedAt)) / 1000)) : 0;
  if (!sameSession) { raw.last_device_session_id = telemetry.deviceSessionId; raw.session_normal_s = 0; raw.session_effective_measurement_s = 0; raw.session_base_growth_granted = 0; raw.earned_continuous_milestones = []; raw.continuous_normal_s = 0; raw.abnormal_active = false; raw.abnormal_severe = false; raw.continuous_snapshot_s = 0; }
  raw.last_recorded_at = telemetry.recordedAt; raw.last_sequence = telemetry.sequence;
  const valid = ['normal', 'left_lean', 'right_lean', 'front_lean', 'back_lean'].includes(telemetry.postureCode);
  if (valid) raw.session_effective_measurement_s = Number(raw.session_effective_measurement_s || 0) + delta;
  raw.reminder_count = telemetry.reminderCount;
  raw.reminder_rate_30m = telemetry.reminderCount * 1800 / Math.max(Number(raw.session_effective_measurement_s || 0), 1800);
  if (telemetry.postureCode === 'normal') {
    raw.today_normal_s += delta; raw.session_normal_s = Number(raw.session_normal_s || 0) + delta;
    if (raw.abnormal_active) {
      if (telemetry.postureDurationSeconds >= 5) {
        raw.continuous_normal_s = raw.abnormal_severe ? Math.max(0, telemetry.postureDurationSeconds - 5) : Number(raw.continuous_snapshot_s || 0) + Math.max(0, telemetry.postureDurationSeconds - 5);
        if (raw.abnormal_severe) raw.recovery_needed = true;
        raw.abnormal_active = false; raw.abnormal_severe = false;
      } else raw.continuous_normal_s = raw.abnormal_severe ? 0 : Number(raw.continuous_snapshot_s || 0);
    } else raw.continuous_normal_s = Math.max(Number(raw.continuous_normal_s || 0), telemetry.postureDurationSeconds);
    raw.instant_tree_state = raw.recovery_needed && telemetry.postureDurationSeconds >= 5 ? 'normal:recovery' : 'normal';
  } else if (['empty', 'unknown'].includes(telemetry.postureCode)) {
    raw.instant_tree_state = telemetry.postureCode === 'unknown' && telemetry.postureDurationSeconds >= 60 ? 'unknown:timeout'
      : telemetry.postureCode === 'empty' && telemetry.postureDurationSeconds >= 900 ? 'empty:session_ended' : telemetry.postureCode;
    if (telemetry.postureCode === 'empty') {
      const rest = raw.tasks.find((item) => item.task_id === 'active_rest_after_60');
      if (rest && Number(raw.session_effective_measurement_s || 0) >= 3600 && telemetry.postureDurationSeconds >= 300 && rest.status !== 'claimed') { rest.progress = 1; rest.status = 'claimed'; raw.resources.sunshine += 2; }
    }
  } else {
    if (!raw.abnormal_active) { raw.abnormal_active = true; raw.continuous_snapshot_s = Number(raw.continuous_normal_s || 0); }
    const level = telemetry.postureDurationSeconds >= 60 ? 'severe' : telemetry.postureDurationSeconds >= 30 ? 'warning' : 'mild';
    raw.instant_tree_state = `${telemetry.postureCode}:${level}`;
    if (level === 'severe') { raw.abnormal_severe = true; raw.continuous_normal_s = 0; }
    else raw.continuous_normal_s = Number(raw.continuous_snapshot_s || 0);
  }
  const factor = raw.reminder_rate_30m < 3 ? 1 : raw.reminder_rate_30m < 5 ? .9 : .8;
  const calculated = Math.floor(Math.floor(Number(raw.session_normal_s || 0) / 60) * factor);
  const grant = Math.min(Math.max(0, calculated - Number(raw.session_base_growth_granted || 0)), Math.max(0, 180 - Number(raw.daily_growth_granted || 0)));
  raw.growth += grant; raw.daily_growth_granted = Number(raw.daily_growth_granted || 0) + grant; raw.session_base_growth_granted = Number(raw.session_base_growth_granted || 0) + grant;
  const rewards = {5:{sunshine:1},15:{water:3},30:{water:3,nutrient:3},45:{sunshine:3,water:3,nutrient:3},60:{sunshine:3,water:3,nutrient:6}};
  const earned = new Set(raw.earned_continuous_milestones || []);
  Object.keys(rewards).forEach((minuteText) => {
    const minute = Number(minuteText);
    if (Number(raw.continuous_normal_s || 0) >= minute * 60 && !earned.has(minute)) {
      earned.add(minute); Object.keys(rewards[minute]).forEach((key) => { raw.resources[key] += rewards[minute][key]; });
    }
  });
  raw.earned_continuous_milestones = Array.from(earned);
  const daily = raw.tasks.find((item) => item.task_id === 'daily_normal_30'); const continuous = raw.tasks.find((item) => item.task_id === 'continuous_25');
  if (daily && daily.status !== 'claimed') { daily.progress = Math.floor(raw.today_normal_s / 60); daily.status = daily.progress >= 30 ? 'claimable' : 'locked'; }
  if (continuous && continuous.status !== 'claimed') { continuous.progress = Math.floor(raw.continuous_normal_s / 60); continuous.status = continuous.progress >= 25 ? 'claimable' : 'locked'; }
  return Promise.resolve(save(raw));
}
function useResource(action, quantity = 1) {
  if (mode() === 'api') return requestGarden({ path: path('/garden/actions'), method: 'POST', data: { action, quantity, idempotency_key: idempotencyKey() } });
  const raw = load();
  const rules = {
    sunbathe: { costs: { sunshine: 3 }, growth: 10 },
    water: { costs: { water: 5 }, growth: 15 },
    fertilize: { costs: { nutrient: 3 }, growth: 30 },
    recover_tree: { costs: { sunshine: 2, nutrient: 3 }, growth: 0 }
  };
  const rule = rules[action];
  if (!rule) return Promise.reject(new Error('未知资源操作'));
  const count = Math.max(1, Math.min(action === 'recover_tree' ? 1 : 5, Number(quantity) || 1));
  if (action === 'recover_tree' && (!raw.recovery_needed || raw.instant_tree_state.indexOf('normal') !== 0)) {
    return Promise.reject(new Error(raw.recovery_needed ? '当前仍有真实异常，请先调整坐姿' : '小树当前不需要恢复'));
  }
  for (const key in rule.costs) if (raw.resources[key] < rule.costs[key] * count) return Promise.reject(new Error('资源不足'));
  for (const key in rule.costs) raw.resources[key] -= rule.costs[key] * count;
  raw.growth += rule.growth * count;
  if (action === 'recover_tree') { raw.recovery_needed = false; raw.instant_tree_state = 'normal'; }
  return Promise.resolve(save(raw));
}
function claimTask(taskId) {
  if (mode() === 'api') return requestGarden({ path: path(`/daily-tasks/${encodeURIComponent(taskId)}/claim`), method: 'POST', data: { idempotency_key: idempotencyKey() } });
  const raw = load();
  const task = raw.tasks.find((item) => item.task_id === taskId);
  if (!task) return Promise.reject(new Error('任务不存在'));
  if (task.status === 'claimed') return Promise.resolve(mapGarden(raw));
  if (task.status !== 'claimable') return Promise.reject(new Error('任务尚不可领取'));
  Object.keys(task.reward).forEach((key) => { raw.resources[key] += task.reward[key]; });
  task.status = 'claimed';
  return Promise.resolve(save(raw));
}
function currentFocus() {
  return Promise.resolve(normalizeFocusTimer(wx.getStorageSync(FOCUS_KEY)));
}
function startFocus(targetMinutes) {
  const target = Number(targetMinutes);
  if (!FOCUS_TARGETS.includes(target)) return Promise.reject(new Error('专注时长只支持 15、30、45 或 60 分钟'));
  const raw = {
    timerId: focusId(), status: 'running', targetMinutes: target,
    startedAtMs: Date.now(), accumulatedBeforeRunSeconds: 0, completedAtMs: null
  };
  wx.setStorageSync(FOCUS_KEY, raw);
  return Promise.resolve(normalizeFocusTimer(raw, false));
}
function pauseFocus() {
  const raw = wx.getStorageSync(FOCUS_KEY);
  const current = normalizeFocusTimer(raw);
  if (!current || current.status !== 'running') return Promise.resolve(current);
  raw.accumulatedBeforeRunSeconds = current.elapsedSeconds;
  raw.startedAtMs = null;
  raw.status = 'paused';
  wx.setStorageSync(FOCUS_KEY, raw);
  return Promise.resolve(normalizeFocusTimer(raw, false));
}
function resumeFocus() {
  const raw = wx.getStorageSync(FOCUS_KEY);
  const current = normalizeFocusTimer(raw);
  if (!current || current.status === 'completed') return Promise.resolve(current);
  raw.accumulatedBeforeRunSeconds = current.elapsedSeconds;
  raw.startedAtMs = Date.now();
  raw.status = 'running';
  wx.setStorageSync(FOCUS_KEY, raw);
  return Promise.resolve(normalizeFocusTimer(raw, false));
}
function endFocus(timerId) {
  const current = normalizeFocusTimer(wx.getStorageSync(FOCUS_KEY));
  if (!current) return Promise.resolve(null);
  if (timerId && current.timerId !== timerId) return Promise.reject(new Error('当前没有对应的专注计时器'));
  wx.removeStorageSync(FOCUS_KEY);
  return Promise.resolve(Object.assign({}, current, { status: current.status === 'completed' ? 'completed' : 'cancelled' }));
}
function quickScenario(scenario) {
  if (!quickEnabled()) return Promise.reject(new Error('快速测试仅在 Mock 模式启用'));
  const raw = load();
  if (scenario.indexOf('stage:') === 0) {
    const values = { seed: 20, sprout: 150, sapling: 420, tree: 720, flower: 1200, fruit: 1600 };
    raw.growth = values[scenario.split(':')[1]];
    return Promise.resolve(save(raw));
  }
  if (scenario === 'tasks') { raw.tasks.forEach((task) => { task.progress = task.target; task.status = ['daily_reminder_lt_5', 'active_rest_after_60'].includes(task.task_id) ? 'claimed' : 'claimable'; }); return Promise.resolve(save(raw)); }
  if (scenario === 'resources') { raw.resources = { sunshine: 99, water: 99, nutrient: 99 }; return Promise.resolve(save(raw)); }
  if (scenario.indexOf('tree:') === 0) {
    const treeState = scenario.slice(5); raw.instant_tree_state = treeState;
    raw.recovery_needed = treeState.indexOf('recovery') >= 0;
    return Promise.resolve(save(raw));
  }
  if (scenario.indexOf('cap:') === 0) { raw.daily_growth_granted = Number(scenario.slice(4)); return Promise.resolve(save(raw)); }
  if (scenario.indexOf('rest:') === 0) {
    const seconds = Number(scenario.slice(5)); const task = raw.tasks.find((item) => item.task_id === 'active_rest_after_60'); raw.session_effective_measurement_s = 3600;
    if (seconds >= 300 && task.status !== 'claimed') raw.resources.sunshine += 2;
    task.progress = Math.min(1, seconds / 300); task.status = seconds >= 300 ? 'claimed' : 'locked';
    raw.instant_tree_state = seconds >= 900 ? 'empty:session_ended' : 'empty'; return Promise.resolve(save(raw));
  }
  if (scenario.indexOf('focus:complete:') === 0) {
    const minutes = Number(scenario.split(':')[2]) || 15;
    if (!FOCUS_TARGETS.includes(minutes)) return Promise.reject(new Error('不支持的专注测试时长'));
    const completedAtMs = Date.now();
    const raw = {
      timerId: focusId(), status: 'completed', targetMinutes: minutes, startedAtMs: null,
      accumulatedBeforeRunSeconds: minutes * 60, completedAtMs
    };
    wx.setStorageSync(FOCUS_KEY, raw);
    wx.setStorageSync(LAST_FOCUS_KEY, raw);
    return Promise.resolve(normalizeFocusTimer(raw, false));
  }
  if (scenario === 'reset') {
    wx.removeStorageSync(GARDEN_KEY);
    wx.removeStorageSync(FOCUS_KEY);
    wx.removeStorageSync(LAST_FOCUS_KEY);
    return Promise.resolve(mapGarden(defaults()));
  }
  return Promise.reject(new Error('未知测试场景'));
}

function getRules() { return mode() === 'mock' ? Promise.resolve({ ruleVersion: 'garden-v1', stages: STAGES }) : api.request({ path: '/game/rules' }).then((payload) => payload.data); }
function getRewardLedger(cursor, limit = 50) { const query = `?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`; return mode() === 'mock' ? Promise.resolve({ items: [] }) : api.request({ path: path(`/reward-ledger${query}`) }); }
function subscribeGame(handlers) {
  const id = studentId(); const token = wx.getStorageSync('accessToken');
  if (mode() === 'mock' || !id || !token) return null;
  const wsBase = api.apiBase().replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
  const socket = wx.connectSocket({ url: `${wsBase}/ws/students/${encodeURIComponent(id)}/game?token=${encodeURIComponent(token)}` });
  socket.onOpen(() => handlers && handlers.onOpen && handlers.onOpen());
  socket.onMessage((event) => {
    try { const envelope = typeof event.data === 'string' ? JSON.parse(event.data) : event.data; if (handlers && handlers.onEvent) handlers.onEvent(envelope); }
    catch (error) { if (handlers && handlers.onError) handlers.onError(error); }
  });
  socket.onError((error) => handlers && handlers.onError && handlers.onError(error));
  socket.onClose(() => handlers && handlers.onClose && handlers.onClose());
  return socket;
}

module.exports = {
  getMode: mode, quickEnabled, getGarden, getRules, getRewardLedger, subscribeGame,
  recordTelemetry, useResource, claimTask, currentFocus, startFocus, pauseFocus, resumeFocus, endFocus, quickScenario
};

wx.removeStorageSync(LEGACY_FOCUS_KEY);
