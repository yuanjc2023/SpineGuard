const postureMeta = {
  empty: { name: '无人就坐', icon: '🪑', risk: 'low', msg: '坐垫当前无人使用', encourage: '休息一下，稍后继续成长🌱' },
  normal: { name: '标准坐姿', icon: '🧘', risk: 'low', msg: '继续保持 🌟', encourage: '保持挺拔，小树在长大🌱' },
  left_lean: { name: '左侧倾斜', icon: '😬', risk: 'medium', msg: '注意坐直，身体向左倾斜', encourage: '扶正身体，小树需要阳光🌿' },
  right_lean: { name: '右侧倾斜', icon: '😅', risk: 'medium', msg: '注意坐直，身体向右倾斜', encourage: '调整坐姿，小树就能长高🎋' },
  front_lean: { name: '身体前倾', icon: '😫', risk: 'high', msg: '前倾明显，建议调整桌椅', encourage: '抬起胸膛，保持舒适坐姿🌳' },
  back_lean: { name: '身体后倾', icon: '🪑', risk: 'medium', msg: '身体后倾，请调整坐姿', encourage: '回到自然坐姿，小树更精神🌿' },
  unknown: { name: '暂时无法识别', icon: '❓', risk: 'medium', msg: '请调整坐姿后重试', encourage: '坐稳一些，很快就能识别✨' }
};

const riskMeta = {
  low: { text: '低', color: '#2ECC71', angle: 120 },
  medium: { text: '中', color: '#F1C40F', angle: 240 },
  high: { text: '高', color: '#E74C3C', angle: 300 }
};

const taskDefinitions = {
  daily_normal_30: { title: '今日正确坐姿累计 30 分钟', unit: '分钟', divisor: 60, reward: { sunshine: 0, water: 6, nutrient: 0 } },
  continuous_25: { title: '连续正确坐姿 25 分钟', unit: '分钟', divisor: 60, reward: { sunshine: 3, water: 3, nutrient: 0 } },
  daily_reminder_lt_5: { title: '有效就坐 30 分钟且提醒少于 5 次', unit: '分钟', divisor: 60, reward: { sunshine: 0, water: 0, nutrient: 3 } },
  active_rest_after_60: { title: '学习满 60 分钟后主动休息', unit: '分钟', divisor: 60, reward: { sunshine: 2, water: 0, nutrient: 0 } }
};

const pressureChannels = ['left', 'right', 'front', 'back', 'center'];

function requireValue(raw, key, scope) {
  if (!raw || raw[key] === undefined || raw[key] === null) {
    throw new Error(`${scope}数据结构缺少 ${key}`);
  }
  return raw[key];
}

function mapFiveChannel(raw, scope) {
  const mapped = {};
  pressureChannels.forEach((key) => {
    mapped[key] = Number(requireValue(raw, key, scope));
  });
  return mapped;
}

/** Converts raw shared/schema.json DTO to the only model consumed by pages. */
function mapTelemetry(raw) {
  if (!raw || ![1, 2].includes(raw.protocol_version)) {
    throw new Error('不支持的遥测协议');
  }
  ['device_id', 'session_id', 'seq', 'timestamp_ms', 'posture', 'confidence', 'pressure', 'pressure_features', 'posture_duration_s', 'sitting_duration_s', 'reminder_count', 'warning_active'].forEach((key) => {
    if (raw[key] === undefined || raw[key] === null) throw new Error(`遥测数据结构缺少 ${key}`);
  });
  const protocolVersion = Number(raw.protocol_version);
  const pressure = mapFiveChannel(raw.pressure, '归一化压力');
  const rawPressure = protocolVersion === 2
    ? mapFiveChannel(requireValue(raw, 'raw_pressure', 'V2遥测'), 'ADC原始压力')
    : null;
  const posture = postureMeta[raw.posture] || postureMeta.unknown;
  const risk = riskMeta[posture.risk];
  const imu = raw.imu || {};
  const backrest = raw.backrest && typeof raw.backrest === 'object'
    ? {
      online: Boolean(raw.backrest.online),
      dataReady: Boolean(raw.backrest.data_ready),
      valid: Boolean(raw.backrest.valid),
      distanceMm: raw.backrest.distance_mm == null ? null : Number(raw.backrest.distance_mm),
      rangeStatus: raw.backrest.range_status == null ? null : Number(raw.backrest.range_status)
    }
    : null;
  const sensorDefinitions = [
    { id: 'left', name: '左侧', x: 0.2, y: 0.5 },
    { id: 'right', name: '右侧', x: 0.8, y: 0.5 },
    { id: 'front', name: '前侧', x: 0.5, y: 0.2 },
    { id: 'back', name: '后侧', x: 0.5, y: 0.8 },
    { id: 'center', name: '中心', x: 0.5, y: 0.5 }
  ];
  return {
    protocolVersion,
    deviceId: raw.device_id,
    deviceSessionId: raw.session_id,
    sequence: raw.seq,
    recordedAt: raw.timestamp_ms,
    deviceName: raw.device_name == null ? null : String(raw.device_name),
    occupied: raw.occupied == null ? null : Boolean(raw.occupied),
    ratioValid: raw.ratio_valid == null ? null : Boolean(raw.ratio_valid),
    postureCode: raw.posture,
    postureName: posture.name,
    postureIcon: posture.icon,
    riskLevel: posture.risk,
    riskLevelText: risk.text,
    riskColor: risk.color,
    riskAngle: risk.angle,
    riskMsg: posture.msg,
    encourageText: posture.encourage,
    confidence: raw.confidence,
    pressure,
    rawPressure,
    pressureFeatures: {
      totalPressure: raw.pressure_features.total_pressure,
      leftRightDiff: raw.pressure_features.left_right_diff,
      frontBackDiff: raw.pressure_features.front_back_diff,
      centerX: raw.pressure_features.center_x,
      centerY: raw.pressure_features.center_y,
      asymmetryIndex: raw.pressure_features.asymmetry_index
    },
    sensorReadings: sensorDefinitions.map((sensor) => ({
      id: sensor.id,
      name: sensor.name,
      x: sensor.x,
      y: sensor.y,
      value: pressure[sensor.id] / 10,
      normalizedValue: pressure[sensor.id],
      rawValue: rawPressure ? rawPressure[sensor.id] : null,
      rawValueText: rawPressure ? String(rawPressure[sensor.id]) : '--'
    })),
    totalPressure: raw.pressure_features.total_pressure,
    asymmetryPercent: Math.round(raw.pressure_features.asymmetry_index * 100),
    centerX: raw.pressure_features.center_x,
    centerY: raw.pressure_features.center_y,
    tiltX: imu.tilt_x == null ? null : Number(imu.tilt_x),
    tiltY: imu.tilt_y == null ? null : Number(imu.tilt_y),
    shakePercent: imu.shake_level == null ? null : Math.round(Number(imu.shake_level) * 100),
    backrest,
    backrestDistanceText: backrest && backrest.online && backrest.valid && backrest.distanceMm != null
      ? `${(backrest.distanceMm / 10).toFixed(1)} cm`
      : '--',
    postureDurationSeconds: raw.posture_duration_s,
    sittingDurationSeconds: raw.sitting_duration_s,
    appliedConfigVersion: raw.applied_config_version == null ? null : Number(raw.applied_config_version),
    vibrationEnabled: raw.vibration_enabled == null ? null : Boolean(raw.vibration_enabled),
    vibrationEffectiveEnabled: raw.vibration_effective_enabled == null ? null : Boolean(raw.vibration_effective_enabled),
    warningActive: raw.warning_active,
    reminderDue: raw.reminder_due == null ? null : Boolean(raw.reminder_due),
    reminderSuppressed: raw.reminder_suppressed == null ? null : Boolean(raw.reminder_suppressed),
    vibrationActive: raw.vibration_active == null ? null : Boolean(raw.vibration_active),
    vibrationPosition: raw.vibration_position == null ? null : String(raw.vibration_position),
    reminderCount: raw.reminder_count,
    reminderCooldownRemainingSeconds: raw.reminder_cooldown_remaining_s == null ? null : Number(raw.reminder_cooldown_remaining_s),
    reminderConfig: raw.reminder_config || null,
    batteryLevel: raw.battery_level == null ? null : Number(raw.battery_level),
    powerSource: raw.power_source == null ? null : String(raw.power_source),
    wifiRssiDbm: raw.wifi_rssi_dbm == null ? null : Number(raw.wifi_rssi_dbm),
    sensorStatus: raw.sensor_status || null,
    commandStatus: raw.command_status || null,
    deviceCredentialMode: raw.device_credential_mode == null ? null : String(raw.device_credential_mode),
    recognitionSource: raw.recognition_source == null ? null : String(raw.recognition_source),
    modelVersion: raw.model_version == null ? null : String(raw.model_version),
    firmwareVersion: raw.firmware_version == null ? null : String(raw.firmware_version)
  };
}

function mapGarden(raw) {
  if (!raw || raw.growth === undefined || !raw.stage || !raw.resources) throw new Error('乐园数据结构不完整');
  ['today_normal_s', 'continuous_normal_s', 'reminder_count', 'reminder_rate_30m', 'daily_growth_granted', 'daily_growth_remaining', 'instant_tree_state', 'recovery_needed', 'tasks', 'rule_version', 'server_time', 'updated_at'].forEach((key) => {
    if (raw[key] === undefined || raw[key] === null) throw new Error(`乐园数据结构缺少 ${key}`);
  });
  const stages = ['seed', 'sprout', 'sapling', 'tree', 'flower', 'fruit'];
  if (!stages.includes(raw.stage)) throw new Error(`未知成长阶段：${raw.stage}`);
  return {
    growth: Number(raw.growth),
    stage: raw.stage,
    resources: {
      sunshine: Number(raw.resources.sunshine || 0),
      water: Number(raw.resources.water || 0),
      nutrient: Number(raw.resources.nutrient || 0)
    },
    todayNormalSeconds: Number(raw.today_normal_s || 0),
    continuousNormalSeconds: Number(raw.continuous_normal_s || 0),
    reminderCount: Number(raw.reminder_count || 0),
    reminderRate30m: Number(raw.reminder_rate_30m || 0),
    dailyGrowthGranted: Number(raw.daily_growth_granted || 0),
    dailyGrowthRemaining: Number(raw.daily_growth_remaining || 0),
    deviceOnline: Boolean(raw.device_online),
    instantTreeState: raw.instant_tree_state || 'normal',
    recoveryNeeded: Boolean(raw.recovery_needed),
    tasks: raw.tasks.map((task) => {
      ['task_id', 'progress', 'target', 'status'].forEach((key) => {
        if (task[key] === undefined || task[key] === null) throw new Error(`每日任务数据结构缺少 ${key}`);
      });
      const definition = taskDefinitions[task.task_id] || { title: task.task_id, unit: '', divisor: 1, reward: {} };
      const divisor = task.unit ? 1 : Number(definition.divisor || 1);
      return {
        taskId: String(task.task_id || task.id || ''),
        title: task.title || task.name || definition.title,
        progress: Math.floor(Number(task.progress || 0) / divisor),
        target: Math.ceil(Number(task.target || 0) / divisor),
        unit: task.unit || definition.unit,
        status: ['locked', 'claimable', 'claimed'].includes(task.status) ? task.status : 'locked',
        reward: {
          sunshine: Number((task.reward || {}).sunshine !== undefined ? task.reward.sunshine : definition.reward.sunshine || 0),
          water: Number((task.reward || {}).water !== undefined ? task.reward.water : definition.reward.water || 0),
          nutrient: Number((task.reward || {}).nutrient !== undefined ? task.reward.nutrient : definition.reward.nutrient || 0)
        }
      };
    }),
    ruleVersion: raw.rule_version || 'unknown',
    serverTime: raw.server_time || '',
    updatedAt: raw.updated_at || ''
  };
}

module.exports = { mapTelemetry, mapGarden };
