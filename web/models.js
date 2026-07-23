(function exposeSpineGuardModels(global) {
  const POSTURE_CODES = ["normal", "left_lean", "right_lean", "front_lean", "back_lean", "empty", "unknown"];
  const GARDEN_STAGES = ["seed", "sprout", "sapling", "tree", "flower", "fruit"];
  const TASK_DEFINITIONS = {
    daily_normal_30: { title: "今日正确坐姿累计 30 分钟", unit: "分钟", divisor: 60, reward: { sunshine: 0, water: 6, nutrient: 0 } },
    continuous_25: { title: "连续正确坐姿 25 分钟", unit: "分钟", divisor: 60, reward: { sunshine: 3, water: 3, nutrient: 0 } },
    daily_reminder_lt_5: { title: "有效就坐 30 分钟且提醒少于 5 次", unit: "分钟", divisor: 60, reward: { sunshine: 0, water: 0, nutrient: 3 } },
    active_rest_after_60: { title: "学习满 60 分钟后主动休息", unit: "分钟", divisor: 60, reward: { sunshine: 2, water: 0, nutrient: 0 } },
  };

  function required(raw, key, scope) {
    if (!raw || raw[key] === undefined || raw[key] === null) {
      throw new Error(`${scope} 数据结构缺少 ${key}`);
    }
    return raw[key];
  }

  function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function nullableNumber(value) {
    return value === undefined || value === null ? null : number(value);
  }

  function mapFiveChannel(raw, scope) {
    required(raw, "left", scope);
    required(raw, "right", scope);
    required(raw, "front", scope);
    required(raw, "back", scope);
    required(raw, "center", scope);
    return {
      left: number(raw.left),
      right: number(raw.right),
      front: number(raw.front),
      back: number(raw.back),
      center: number(raw.center),
    };
  }

  function mapTelemetry(raw) {
    const protocolVersion = number(raw?.protocol_version, -1);
    if (![1, 2].includes(protocolVersion)) throw new Error(`不支持的遥测协议：V${raw?.protocol_version ?? "unknown"}`);
    required(raw, "device_id", "遥测");
    required(raw, "session_id", "遥测");
    required(raw, "seq", "遥测");
    required(raw, "timestamp_ms", "遥测");
    required(raw, "posture", "遥测");
    required(raw, "pressure", "遥测");
    required(raw, "pressure_features", "遥测");
    ["confidence", "posture_duration_s", "sitting_duration_s", "reminder_count", "warning_active"]
      .forEach((key) => required(raw, key, "遥测"));
    if (!POSTURE_CODES.includes(raw.posture)) throw new Error(`未知姿态枚举：${raw.posture}`);
    const pressure = mapFiveChannel(raw.pressure, "归一化压力");
    const rawPressure = protocolVersion === 2
      ? mapFiveChannel(required(raw, "raw_pressure", "V2 遥测"), "ADC 原始压力")
      : null;
    const features = raw.pressure_features;
    return {
      protocolVersion,
      deviceId: String(raw.device_id),
      deviceSessionId: String(raw.session_id),
      sequence: number(raw.seq),
      recordedAt: number(raw.timestamp_ms),
      deviceName: raw.device_name == null ? null : String(raw.device_name),
      occupied: raw.occupied == null ? null : Boolean(raw.occupied),
      ratioValid: raw.ratio_valid == null ? null : Boolean(raw.ratio_valid),
      postureCode: raw.posture,
      confidence: number(raw.confidence),
      postureDurationSeconds: number(raw.posture_duration_s),
      sittingDurationSeconds: number(raw.sitting_duration_s),
      reminderCount: number(raw.reminder_count),
      warningActive: Boolean(raw.warning_active),
      batteryLevel: nullableNumber(raw.battery_level),
      powerSource: raw.power_source == null ? null : String(raw.power_source),
      wifiRssiDbm: nullableNumber(raw.wifi_rssi_dbm),
      recognitionSource: raw.recognition_source == null ? null : String(raw.recognition_source),
      modelVersion: raw.model_version == null ? null : String(raw.model_version),
      firmwareVersion: raw.firmware_version == null ? null : String(raw.firmware_version),
      appliedConfigVersion: nullableNumber(raw.applied_config_version),
      vibrationEnabled: raw.vibration_enabled == null ? null : Boolean(raw.vibration_enabled),
      vibrationEffectiveEnabled: raw.vibration_effective_enabled == null ? null : Boolean(raw.vibration_effective_enabled),
      reminderDue: raw.reminder_due == null ? null : Boolean(raw.reminder_due),
      reminderSuppressed: raw.reminder_suppressed == null ? null : Boolean(raw.reminder_suppressed),
      vibrationActive: raw.vibration_active == null ? null : Boolean(raw.vibration_active),
      vibrationPosition: raw.vibration_position == null ? null : String(raw.vibration_position),
      reminderCooldownRemainingSeconds: nullableNumber(raw.reminder_cooldown_remaining_s),
      reminderConfig: raw.reminder_config && typeof raw.reminder_config === "object" ? { ...raw.reminder_config } : null,
      sensorStatus: raw.sensor_status && typeof raw.sensor_status === "object" ? { ...raw.sensor_status } : null,
      commandStatus: raw.command_status && typeof raw.command_status === "object" ? { ...raw.command_status } : null,
      deviceCredentialMode: raw.device_credential_mode == null ? null : String(raw.device_credential_mode),
      backrest: raw.backrest && typeof raw.backrest === "object"
        ? {
          online: Boolean(raw.backrest.online),
          dataReady: Boolean(raw.backrest.data_ready),
          valid: Boolean(raw.backrest.valid),
          distanceMm: nullableNumber(raw.backrest.distance_mm),
          rangeStatus: nullableNumber(raw.backrest.range_status),
        }
        : null,
      pressure,
      rawPressure,
      pressureFeatures: {
        totalPressure: number(features.total_pressure),
        leftRightDiff: number(features.left_right_diff),
        frontBackDiff: number(features.front_back_diff),
        centerX: number(features.center_x),
        centerY: number(features.center_y),
        asymmetryIndex: number(features.asymmetry_index),
      },
    };
  }

  function mapTask(raw) {
    ["task_id", "progress", "target", "status"].forEach((key) => required(raw, key, "每日任务"));
    const status = raw.status || "locked";
    if (!["locked", "claimable", "claimed"].includes(status)) throw new Error(`未知任务状态：${status}`);
    const definition = TASK_DEFINITIONS[raw.task_id] || { title: raw.task_id, unit: "", divisor: 1, reward: {} };
    const divisor = raw.unit ? 1 : number(definition.divisor, 1);
    return {
      taskId: String(raw.task_id || raw.id || ""),
      title: String(raw.title || raw.name || definition.title),
      progress: Math.floor(number(raw.progress) / divisor),
      target: Math.ceil(number(raw.target) / divisor),
      unit: String(raw.unit || definition.unit),
      status,
      reward: {
        sunshine: number(raw.reward?.sunshine ?? definition.reward.sunshine),
        water: number(raw.reward?.water ?? definition.reward.water),
        nutrient: number(raw.reward?.nutrient ?? definition.reward.nutrient),
      },
    };
  }

  function mapGarden(raw) {
    required(raw, "growth", "乐园");
    required(raw, "stage", "乐园");
    required(raw, "resources", "乐园");
    ["today_normal_s", "continuous_normal_s", "reminder_count", "reminder_rate_30m", "daily_growth_granted", "daily_growth_remaining", "instant_tree_state", "recovery_needed", "tasks", "rule_version", "server_time", "updated_at"]
      .forEach((key) => required(raw, key, "乐园"));
    if (!GARDEN_STAGES.includes(raw.stage)) throw new Error(`未知成长阶段：${raw.stage}`);
    return {
      growth: number(raw.growth),
      stage: raw.stage,
      resources: {
        sunshine: number(raw.resources.sunshine), water: number(raw.resources.water), nutrient: number(raw.resources.nutrient),
      },
      todayNormalSeconds: number(raw.today_normal_s),
      continuousNormalSeconds: number(raw.continuous_normal_s),
      reminderCount: number(raw.reminder_count),
      reminderRate30m: number(raw.reminder_rate_30m),
      dailyGrowthGranted: number(raw.daily_growth_granted),
      dailyGrowthRemaining: number(raw.daily_growth_remaining),
      deviceOnline: Boolean(raw.device_online),
      instantTreeState: String(raw.instant_tree_state || "normal"),
      recoveryNeeded: Boolean(raw.recovery_needed),
      tasks: Array.isArray(raw.tasks) ? raw.tasks.map(mapTask) : [],
      ruleVersion: String(raw.rule_version || "unknown"),
      serverTime: String(raw.server_time),
      updatedAt: String(raw.updated_at || new Date(0).toISOString()),
    };
  }

  const models = { POSTURE_CODES, GARDEN_STAGES, mapTelemetry, mapGarden };
  global.SpineGuardModels = models;
  if (typeof module !== "undefined" && module.exports) module.exports = models;
})(typeof window !== "undefined" ? window : globalThis);
