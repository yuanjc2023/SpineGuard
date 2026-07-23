(function exposeGardenService(global) {
  const STORAGE_KEY = "sg.mock.garden.v2";
  const STAGE_LIMITS = [
    ["seed", 0], ["sprout", 100], ["sapling", 300], ["tree", 600], ["flower", 1000], ["fruit", 1500],
  ];
  const config = global.SPINEGUARD_CONFIG || {};
  const queryMode = new URLSearchParams(location.search).get("mode");
  const mode = queryMode === "mock" || queryMode === "api" ? queryMode : (config.mode || (config.useMock === false ? "api" : "mock"));
  const quick = mode === "mock" && (new URLSearchParams(location.search).get("quick") === "1" || config.quickTest === true);

  const clone = (value) => JSON.parse(JSON.stringify(value));
  const now = () => new Date().toISOString();
  const localDate = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  const idempotencyKey = () => global.crypto?.randomUUID?.() || `web-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const stageFor = (growth) => [...STAGE_LIMITS].reverse().find(([, min]) => growth >= min)?.[0] || "seed";
  const defaults = () => ({
    growth: 486,
    stage: "sapling",
    resources: { sunshine: 12, water: 18, nutrient: 6 },
    today_normal_s: 26 * 60,
    continuous_normal_s: 12 * 60,
    reminder_count: 3,
    reminder_rate_30m: 3,
    instant_tree_state: "normal",
    recovery_needed: false,
    tasks: [
      { task_id: "daily_normal_30", title: "今日正确坐姿累计 30 分钟", progress: 26, target: 30, unit: "分钟", status: "locked", reward: { sunshine: 0, water: 6, nutrient: 0 } },
      { task_id: "continuous_25", title: "连续正确坐姿 25 分钟", progress: 12, target: 25, unit: "分钟", status: "locked", reward: { sunshine: 3, water: 3, nutrient: 0 } },
      { task_id: "daily_reminder_lt_5", title: "有效就坐 30 分钟且提醒少于 5 次", progress: 26, target: 30, unit: "分钟", status: "locked", reward: { sunshine: 0, water: 0, nutrient: 3 } },
      { task_id: "active_rest_after_60", title: "学习满 60 分钟后主动休息", progress: 0, target: 5, unit: "分钟", status: "locked", reward: { sunshine: 2, water: 0, nutrient: 0 } },
    ],
    rule_version: "garden-v1-taskbook",
    updated_at: now(),
    daily_growth_granted: 0,
    daily_growth_remaining: 180,
    server_time: now(),
    local_date: localDate(),
  });

  function normalizeDaily(raw) {
    const today = localDate();
    if (!raw.local_date) raw.local_date = today;
    if (raw.local_date === today) return raw;
    const reminderTask = (raw.tasks || []).find((task) => ["daily_reminder_lt_5", "few_reminders"].includes(task.task_id));
    if (Number(raw.session_effective_measurement_s || 0) >= 1800 && Number(raw.reminder_count || 0) < 5 && reminderTask?.status !== "claimed") {
      raw.resources.nutrient += 3;
    }
    const fresh = defaults();
    raw.local_date = today;
    raw.today_normal_s = 0;
    raw.daily_growth_granted = 0;
    raw.daily_growth_remaining = 180;
    raw.session_normal_s = 0;
    raw.session_base_growth_granted = 0;
    raw.reminder_count = 0;
    raw.reminder_rate_30m = 0;
    raw.tasks = fresh.tasks;
    return raw;
  }

  function loadRaw() {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (!stored) return defaults();
      if (stored.today_normal_s === undefined) stored.today_normal_s = Number(stored.today_normal_seconds || 0);
      if (stored.continuous_normal_s === undefined) stored.continuous_normal_s = Number(stored.continuous_normal_seconds || 0);
      delete stored.today_normal_seconds;
      delete stored.continuous_normal_seconds;
      const taskAliases = { daily_30: "daily_normal_30", few_reminders: "daily_reminder_lt_5", active_break: "active_rest_after_60" };
      (stored.tasks || []).forEach((task) => { task.task_id = taskAliases[task.task_id] || task.task_id; });
      return normalizeDaily({ ...defaults(), ...stored, resources: { ...defaults().resources, ...(stored.resources || {}) } });
    } catch (_) { return defaults(); }
  }
  function saveRaw(raw) {
    raw.stage = stageFor(raw.growth);
    raw.daily_growth_remaining = Math.max(0, 180 - Number(raw.daily_growth_granted || 0));
    raw.server_time = now();
    raw.updated_at = now();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(raw));
    return global.SpineGuardModels.mapGarden(clone(raw));
  }
  async function unavailable() {
    const error = new Error("后端乐园接口不可用；API 模式不会修改本地奖励");
    error.status = 501;
    throw error;
  }
  async function request(path, options) {
    const api = global.SpineGuardRealApi;
    if (!api?.requestRaw) return unavailable();
    return api.requestRaw(path, options);
  }
  function studentPath(studentId, suffix) {
    if (!studentId) throw new Error("请先选择学生");
    return `/students/${encodeURIComponent(studentId)}${suffix}`;
  }

  const mock = {
    async getGarden() { return global.SpineGuardModels.mapGarden(loadRaw()); },
    async recordTelemetry(telemetry) {
      const raw = loadRaw();
      const sameSession = raw.last_device_session_id === telemetry.deviceSessionId;
      if (sameSession && Number(telemetry.sequence) <= Number(raw.last_sequence ?? -1)) return global.SpineGuardModels.mapGarden(raw);
      const delta = sameSession ? Math.max(0, Math.min(10, (telemetry.recordedAt - Number(raw.last_recorded_at || telemetry.recordedAt)) / 1000)) : 0;
      if (!sameSession) {
        raw.last_device_session_id = telemetry.deviceSessionId;
        raw.session_normal_s = 0; raw.session_effective_measurement_s = 0; raw.session_base_growth_granted = 0; raw.earned_continuous_milestones = [];
        raw.continuous_normal_s = 0;
        raw.abnormal_active = false; raw.abnormal_severe = false; raw.continuous_snapshot_s = 0;
      }
      raw.last_recorded_at = telemetry.recordedAt; raw.last_sequence = telemetry.sequence;
      const valid = ["normal", "left_lean", "right_lean", "front_lean", "back_lean"].includes(telemetry.postureCode);
      if (valid) raw.session_effective_measurement_s = Number(raw.session_effective_measurement_s || 0) + delta;
      raw.reminder_count = telemetry.reminderCount;
      raw.reminder_rate_30m = telemetry.reminderCount * 1800 / Math.max(Number(raw.session_effective_measurement_s || 0), 1800);
      if (telemetry.postureCode === "normal") {
        raw.today_normal_s += delta; raw.session_normal_s = Number(raw.session_normal_s || 0) + delta;
        if (raw.abnormal_active) {
          if (telemetry.postureDurationSeconds >= 5) {
            raw.continuous_normal_s = raw.abnormal_severe ? Math.max(0, telemetry.postureDurationSeconds - 5)
              : Number(raw.continuous_snapshot_s || 0) + Math.max(0, telemetry.postureDurationSeconds - 5);
            if (raw.abnormal_severe) raw.recovery_needed = true;
            raw.abnormal_active = false; raw.abnormal_severe = false;
          } else raw.continuous_normal_s = raw.abnormal_severe ? 0 : Number(raw.continuous_snapshot_s || 0);
        } else raw.continuous_normal_s = Math.max(Number(raw.continuous_normal_s || 0), telemetry.postureDurationSeconds);
        raw.instant_tree_state = raw.recovery_needed && telemetry.postureDurationSeconds >= 5 ? "normal:recovery" : "normal";
      } else if (["empty", "unknown"].includes(telemetry.postureCode)) {
        raw.instant_tree_state = telemetry.postureCode === "unknown" && telemetry.postureDurationSeconds >= 60 ? "unknown:timeout"
          : telemetry.postureCode === "empty" && telemetry.postureDurationSeconds >= 900 ? "empty:session_ended" : telemetry.postureCode;
        if (telemetry.postureCode === "empty") {
          const restTask = raw.tasks.find((item) => item.task_id === "active_rest_after_60");
          if (restTask && Number(raw.session_effective_measurement_s || 0) >= 3600 && telemetry.postureDurationSeconds >= 300 && restTask.status !== "claimed") {
            restTask.progress = 5; restTask.status = "claimed"; raw.resources.sunshine += 2;
          }
        }
      } else {
        if (!raw.abnormal_active) {
          raw.abnormal_active = true;
          raw.continuous_snapshot_s = Number(raw.continuous_normal_s || 0);
        }
        const level = telemetry.postureDurationSeconds >= 60 ? "severe" : telemetry.postureDurationSeconds >= 30 ? "warning" : "mild";
        raw.instant_tree_state = `${telemetry.postureCode}:${level}`;
        if (level === "severe") { raw.abnormal_severe = true; raw.continuous_normal_s = 0; }
        else raw.continuous_normal_s = Number(raw.continuous_snapshot_s || 0);
      }
      const factor = raw.reminder_rate_30m < 3 ? 1 : raw.reminder_rate_30m < 5 ? 0.9 : 0.8;
      const calculated = Math.floor(Math.floor(Number(raw.session_normal_s || 0) / 60) * factor);
      const ungranted = Math.max(0, calculated - Number(raw.session_base_growth_granted || 0));
      const grant = Math.min(ungranted, Math.max(0, 180 - Number(raw.daily_growth_granted || 0)));
      raw.growth += grant; raw.daily_growth_granted = Number(raw.daily_growth_granted || 0) + grant; raw.session_base_growth_granted = Number(raw.session_base_growth_granted || 0) + grant;
      const milestoneRewards = {5:{sunshine:1},15:{water:3},30:{water:3,nutrient:3},45:{sunshine:3,water:3,nutrient:3},60:{sunshine:3,water:3,nutrient:6}};
      const earned = new Set(raw.earned_continuous_milestones || []);
      Object.entries(milestoneRewards).forEach(([minute, reward]) => {
        if (Number(raw.continuous_normal_s || 0) >= Number(minute) * 60 && !earned.has(Number(minute))) {
          earned.add(Number(minute)); Object.entries(reward).forEach(([key, value]) => { raw.resources[key] += value; });
        }
      });
      raw.earned_continuous_milestones = [...earned];
      const daily = raw.tasks.find((item) => item.task_id === "daily_normal_30");
      const continuous = raw.tasks.find((item) => item.task_id === "continuous_25");
      if (daily && daily.status !== "claimed") { daily.progress = Math.floor(raw.today_normal_s / 60); daily.status = daily.progress >= 30 ? "claimable" : "locked"; }
      if (continuous && continuous.status !== "claimed") { continuous.progress = Math.floor(raw.continuous_normal_s / 60); continuous.status = continuous.progress >= 25 ? "claimable" : "locked"; }
      return saveRaw(raw);
    },
    async useResource(_studentId, action, quantity = 1) {
      const raw = loadRaw();
      const rules = {
        sunbathe: { costs: { sunshine: 3 }, growth: 10 }, water: { costs: { water: 5 }, growth: 15 },
        fertilize: { costs: { nutrient: 3 }, growth: 30 }, recover_tree: { costs: { sunshine: 2, nutrient: 3 }, growth: 0 },
      };
      const rule = rules[action];
      if (!rule) throw new Error("未知资源操作");
      const count = Math.max(1, Math.min(action === "recover_tree" ? 1 : 5, Number(quantity) || 1));
      if (action === "recover_tree" && (!raw.recovery_needed || !raw.instant_tree_state.startsWith("normal"))) {
        throw new Error(raw.recovery_needed ? "当前仍有真实异常，请先调整坐姿" : "小树当前不需要恢复");
      }
      for (const [key, cost] of Object.entries(rule.costs)) if (raw.resources[key] < cost * count) throw new Error("资源不足");
      for (const [key, cost] of Object.entries(rule.costs)) raw.resources[key] -= cost * count;
      raw.growth += rule.growth * count;
      if (action === "recover_tree") { raw.recovery_needed = false; raw.instant_tree_state = "normal"; }
      return saveRaw(raw);
    },
    async claimTask(_studentId, taskId) {
      const raw = loadRaw();
      const task = raw.tasks.find((item) => item.task_id === taskId);
      if (!task) throw new Error("任务不存在");
      if (task.status === "claimed") return global.SpineGuardModels.mapGarden(raw);
      if (task.status !== "claimable") throw new Error("任务尚不可领取");
      Object.entries(task.reward).forEach(([key, value]) => { raw.resources[key] += value; });
      task.status = "claimed";
      return saveRaw(raw);
    },
    async quickScenario(_studentId, scenario) {
      if (!quick) throw new Error("快速测试仅在 Mock 快速模式可用");
      if (scenario.startsWith("stage:")) {
        const values = { seed: 20, sprout: 150, sapling: 420, tree: 720, flower: 1200, fruit: 1600 };
        const raw = loadRaw(); raw.growth = values[scenario.split(":")[1]] ?? raw.growth; return saveRaw(raw);
      }
      if (scenario === "tasks:claimable") {
        const raw = loadRaw(); raw.tasks.forEach((task) => { task.progress = task.target; task.status = ["daily_reminder_lt_5", "active_rest_after_60"].includes(task.task_id) ? "claimed" : "claimable"; }); return saveRaw(raw);
      }
      if (scenario === "resources:rich") {
        const raw = loadRaw(); raw.resources = { sunshine: 99, water: 99, nutrient: 99 }; return saveRaw(raw);
      }
      if (scenario.startsWith("tree:")) {
        const raw = loadRaw();
        const treeState = scenario.slice(5);
        raw.instant_tree_state = treeState;
        raw.recovery_needed = treeState.includes("recovery");
        return saveRaw(raw);
      }
      if (scenario.startsWith("cap:")) {
        const raw = loadRaw(); raw.daily_growth_granted = Number(scenario.slice(4)); return saveRaw(raw);
      }
      if (scenario.startsWith("rest:")) {
        const seconds = Number(scenario.slice(5));
        const raw = loadRaw(); const task = raw.tasks.find((item) => item.task_id === "active_rest_after_60");
        raw.session_effective_measurement_s = 3600;
        if (seconds >= 300 && task.status !== "claimed") raw.resources.sunshine += 2;
        task.progress = Math.min(5, Math.floor(seconds / 60)); task.status = seconds >= 300 ? "claimed" : "locked";
        raw.instant_tree_state = seconds >= 900 ? "empty:session_ended" : "empty";
        return saveRaw(raw);
      }
      throw new Error("未知快速测试场景");
    },
    reset() { localStorage.removeItem(STORAGE_KEY); return this.getGarden(); },
    async getRules() { return { ruleVersion: "garden-v1-taskbook", stages: clone(STAGE_LIMITS) }; },
    async getRewardLedger() { return { items: [] }; },
  };

  const api = {
    async getGarden(studentId) { const result = await request(studentPath(studentId, "/garden")); return global.SpineGuardModels.mapGarden(result.data); },
    async getRules() { const result = await request("/game/rules"); return result.data; },
    async useResource(studentId, action, quantity = 1) { const result = await request(studentPath(studentId, "/garden/actions"), { method: "POST", body: { action, quantity, idempotency_key: idempotencyKey() } }); return global.SpineGuardModels.mapGarden(result.data); },
    async claimTask(studentId, taskId) { const result = await request(studentPath(studentId, `/daily-tasks/${encodeURIComponent(taskId)}/claim`), { method: "POST", body: { idempotency_key: idempotencyKey() } }); return global.SpineGuardModels.mapGarden(result.data); },
    async getRewardLedger(studentId, cursor = "", limit = 50) { const query = new URLSearchParams({ limit: String(limit), ...(cursor ? { cursor } : {}) }); return request(studentPath(studentId, `/reward-ledger?${query}`)); },
    quickScenario: unavailable,
    recordTelemetry() {},
    reset: unavailable,
  };

  global.SpineGuardGardenService = Object.assign(mode === "mock" ? mock : api, { mode, quickTestEnabled: quick });

})(window);
