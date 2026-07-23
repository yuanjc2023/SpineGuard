(function exposeMockApi(global) {
  const DB_KEY = "sg.mock.database.v8";
  const CLASS_ID = "五年级三班";
  const nowIso = () => new Date().toISOString();
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const mockDate = (value) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(value);
  const mockWeekEnd = (() => { const value = new Date(); const day = value.getDay() || 7; value.setDate(value.getDate() - day); return value; })();
  const mockWeekStart = (() => { const value = new Date(mockWeekEnd); value.setDate(value.getDate() - 6); return value; })();

  const studentNames = [
    "小林同学", "小希同学", "小李同学", "小周同学", "小陈同学", "小王同学", "小赵同学", "小孙同学",
    "小吴同学", "小郑同学", "小何同学", "小许同学", "小冯同学", "小曹同学", "小梁同学", "小谢同学",
    "小唐同学", "小宋同学", "小韩同学", "小邓同学", "小彭同学", "小曾同学", "小萧同学", "小田同学",
    "小董同学", "小袁同学", "小潘同学", "小于同学", "小蒋同学", "小蔡同学", "小罗同学", "小叶同学",
  ];
  const currentPostures = [
    ...Array(22).fill("normal"),
    "left_lean", "left_lean", "right_lean", "right_lean", "front_lean", "front_lean", "back_lean", "empty", "front_lean", "left_lean",
  ];
  const stageOrder = ["seed", "sprout", "sapling", "tree", "flower", "fruit"];
  const stageGrowth = [58, 168, 438, 768, 1180, 1650];
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const idNumber = (studentId) => clamp((Number(String(studentId).match(/(\d+)$/)?.[1]) || 1) - 1, 0, studentNames.length - 1);

  function scenarioFor(studentId) {
    const index = idNumber(studentId);
    const redIndexes = [26, 27];
    const yellowIndexes = [22, 23, 24, 25, 28, 29];
    const redPosition = redIndexes.indexOf(index);
    const yellowPosition = yellowIndexes.indexOf(index);
    const riskLevel = redPosition >= 0 ? "red" : yellowPosition >= 0 ? "yellow" : "green";
    const riskScore = riskLevel === "red" ? 76 + redPosition * 8
      : riskLevel === "yellow" ? 38 + yellowPosition * 5
        : 8 + ((index * 7) % 25);
    const normalRatio = riskLevel === "red" ? .52 + redPosition * .03
      : riskLevel === "yellow" ? .64 + ((index * 3) % 9) / 100
        : .78 + ((index * 7) % 16) / 100;
    const stageIndex = (index * 5 + 2) % stageOrder.length;
    const progressDelta = ((index * 5) % 11 - 3) / 100;
    return {
      index,
      posture: currentPostures[index],
      online: index < 30,
      riskLevel,
      riskScore,
      normalRatio,
      previousRatio: clamp(normalRatio - progressDelta, .45, .96),
      progressDelta,
      totalSittingSeconds: 5400 + ((index * 317) % 4500),
      reminderCount: riskLevel === "red" ? 11 + (index % 3) : riskLevel === "yellow" ? 5 + (index % 4) : 1 + (index % 4),
      asymmetry: riskLevel === "red" ? .38 + (index % 2) * .05 : riskLevel === "yellow" ? .22 + (index % 4) * .025 : .07 + (index % 5) * .018,
      consecutiveDays: riskLevel === "red" ? 5 + (index % 3) : riskLevel === "yellow" ? 2 + (index % 4) : 0,
      trend: index % 9 === 0 ? "down" : index % 7 === 0 ? "new" : "stable",
      stage: stageOrder[stageIndex],
      growth: stageGrowth[stageIndex] + ((index * 17) % 90),
    };
  }

  const mockStudents = studentNames.map((displayCode, index) => ({
    student_id: `STU-MOCK-${String(index + 1).padStart(3, "0")}`,
    display_code: displayCode,
    school_id: "SCH-MOCK",
    class_id: CLASS_ID,
    owner: index === 0 ? "USR-MOCK-PARENT" : null,
  }));
  const mockDevices = mockStudents.map((student, index) => {
    const online = index < 30;
    const battery = index === 27 ? 18 : index === 29 ? 12 : 42 + ((index * 13) % 55);
    const lastSeen = new Date(Date.now() - (online ? (index % 9) * 1000 : (index === 30 ? 2 * 3600000 : 26 * 3600000))).toISOString();
    return {
      device_id: `SG-${String(index + 1).padStart(4, "0")}`,
      device_name: `SpineGuard ${String(index + 1).padStart(4, "0")}`,
      firmware_version: "0.5.0-device-management",
      model_version: "spineguard_lightgbm_fsr_tof_v2",
      battery_level: battery,
      online_status: online ? "online" : "offline",
      last_seen_at: lastSeen,
      student_id: student.student_id,
      config_version: 1,
      applied_config_version: 1,
      power_source: "power_bank",
      wifi_rssi_dbm: -48 - (index % 20),
      sensor_status: {
        fsr: {left: "ok", right: "ok", front: "ok", back: "ok", center: "ok", all_ok: true, baseline_valid: true},
        tof: {online: true, valid: true},
        motor: {control_ready: true, self_test_completed: true, power_verified: false},
      },
      reminder: {enabled: true, mode: "normal", trigger_duration_s: 300, vibration_duration_s: 10, cooldown_s: 600, intensity_percent: 40},
    };
  });

  function mockReportSummary(studentId, recordLimit = 600) {
    const scenario = scenarioFor(studentId);
    const effective = Math.max(1800, scenario.totalSittingSeconds);
    const normal = Math.round(effective * scenario.normalRatio);
    const poor = effective - normal;
    const weights = {left_lean: .26, right_lean: .21, front_lean: .39, back_lean: .14};
    const postureStats = {
      normal: {duration_s: normal, ratio: scenario.normalRatio},
      ...Object.fromEntries(Object.entries(weights).map(([key, weight]) => [key, {duration_s: Math.round(poor * weight), ratio: Number(((poor * weight) / effective).toFixed(4))}])),
    };
    const direction = scenario.progressDelta > .03 ? "improving" : scenario.progressDelta < -.03 ? "worsening" : "stable";
    return {
      record_count: Math.min(recordLimit, 480 + scenario.index * 7),
      data_start_at: new Date(Date.now() - 6 * 86400000).toISOString(),
      data_end_at: nowIso(),
      effective_sitting_s: effective,
      total_sitting_s: effective,
      normal_sitting_s: normal,
      normal_ratio: scenario.normalRatio,
      poor_sitting_s: poor,
      posture_stats: postureStats,
      reminder_count: scenario.reminderCount,
      reminder_peak_day: {date: mockDate(new Date()), count: Math.max(1, Math.ceil(scenario.reminderCount / 2))},
      max_continuous_abnormal_s: scenario.riskLevel === "red" ? 420 : scenario.riskLevel === "yellow" ? 210 : 70,
      avg_asymmetry_index: scenario.asymmetry,
      trend: {direction, description: direction === "improving" ? "后半段非标准坐姿比例下降，姿态表现有所改善。" : direction === "worsening" ? "后半段非标准坐姿比例上升，姿态表现有所变差。" : "前后半段非标准坐姿比例变化不大，姿态表现基本稳定。"},
      daily_items: [],
    };
  }

  const initialWeeklySummary = mockReportSummary("STU-MOCK-001", 600);

  const initialDb = {
    users: [
      {user_id: "USR-MOCK-PARENT", username: "parent_demo", password: "parent123", role: "parent"},
      {user_id: "USR-MOCK-ADMIN", username: "school_admin_demo", password: "admin123", role: "school_admin"},
    ],
    students: mockStudents,
    devices: mockDevices,
    pairings: [],
    telemetry: [],
    reports: [{report_id: 1, student_id: "STU-MOCK-001", report_type: "weekly", period_start: mockDate(mockWeekStart), period_end: mockDate(mockWeekEnd), summary: initialWeeklySummary, content: "上周标准坐姿表现总体稳定，主要异常为前倾。建议每 40 分钟主动离座活动，并继续保持坐垫中央就坐。", generated_by: "rule", created_at: nowIso()}],
    notifications: [
      {notification_id: "NOT-MOCK-001", user_id: "USR-MOCK-PARENT", student_id: "STU-MOCK-001", notification_type: "report", title: "坐姿周报已生成", content: `${mockDate(mockWeekStart)} 至 ${mockDate(mockWeekEnd)} 的坐姿行为周报已生成，可前往报告中心查看。`, is_read: false, related_report_id: 1, created_at: nowIso(), read_at: null},
      {notification_id: "NOT-MOCK-002", user_id: "USR-MOCK-ADMIN", student_id: "STU-MOCK-027", notification_type: "risk", title: "红色风险学生需关注", content: "小潘同学近期前倾持续时间偏长。", is_read: false, created_at: nowIso(), read_at: null},
    ],
    seq: 0,
  };

  function loadDb() {
    const stored = localStorage.getItem(DB_KEY);
    if (!stored) {
      localStorage.setItem(DB_KEY, JSON.stringify(initialDb));
      return clone(initialDb);
    }
    try { return JSON.parse(stored); } catch (_) { return clone(initialDb); }
  }

  let db = loadDb();
  const save = () => localStorage.setItem(DB_KEY, JSON.stringify(db));
  const ok = (data) => Promise.resolve(data);
  const fail = (message, status = 400) => {
    const error = new Error(message);
    error.status = status;
    return Promise.reject(error);
  };
  const tokenUser = () => {
    const username = (sessionStorage.getItem("sg.access_token") || "").replace(/^mock:/, "");
    return db.users.find((item) => item.username === username) || null;
  };
  const publicUser = (user) => ({user_id: user.user_id, username: user.username, role: user.role});
  const visibleStudents = () => {
    const user = tokenUser();
    if (!user) return [];
    return user.role === "parent" ? db.students.filter((item) => item.owner === user.user_id) : db.students;
  };
  const visibleDevices = () => {
    const ids = new Set(visibleStudents().map((item) => item.student_id));
    return tokenUser()?.role === "parent" ? db.devices.filter((item) => ids.has(item.student_id)) : db.devices;
  };

  const profiles = [
    {posture: "normal", confidence: 0.96, pressure: {left: 520, right: 510, front: 430, back: 620, center: 760}, imu: {tilt_x: 1.2, tilt_y: -0.5, shake_level: 0.03}},
    {posture: "left_lean", confidence: 0.93, pressure: {left: 850, right: 260, front: 430, back: 610, center: 700}, imu: {tilt_x: -12.4, tilt_y: -1.8, shake_level: 0.08}},
    {posture: "right_lean", confidence: 0.92, pressure: {left: 250, right: 860, front: 420, back: 600, center: 700}, imu: {tilt_x: 13.1, tilt_y: -1.1, shake_level: 0.07}},
    {posture: "front_lean", confidence: 0.94, pressure: {left: 520, right: 510, front: 850, back: 250, center: 650}, imu: {tilt_x: 0.8, tilt_y: 18.6, shake_level: 0.05}},
    {posture: "back_lean", confidence: 0.91, pressure: {left: 510, right: 520, front: 260, back: 860, center: 690}, imu: {tilt_x: -0.4, tilt_y: -16.2, shake_level: 0.04}},
    {posture: "empty", confidence: 0.99, pressure: {left: 0, right: 0, front: 0, back: 0, center: 0}, imu: {tilt_x: 0, tilt_y: 0, shake_level: 0}},
  ];

  function features(pressure) {
    const total = Object.values(pressure).reduce((sum, value) => sum + value, 0);
    const leftRight = pressure.left - pressure.right;
    const frontBack = pressure.front - pressure.back;
    return {
      total_pressure: total,
      left_right_diff: leftRight,
      front_back_diff: frontBack,
      center_x: total ? Number(Math.max(-1, Math.min(1, (pressure.right - pressure.left) / 1000)).toFixed(3)) : 0,
      center_y: total ? Number(Math.max(-1, Math.min(1, (pressure.front - pressure.back) / 1000)).toFixed(3)) : 0,
      asymmetry_index: total ? Number(Math.min(1, (Math.abs(leftRight) + Math.abs(frontBack)) / 2000).toFixed(3)) : 0,
    };
  }

  function rawPressureFromNormalized(pressure) {
    return Object.fromEntries(Object.entries(pressure).map(([key, value]) => [
      key,
      Math.max(0, Math.min(4095, Math.round(Number(value || 0) * 4.095))),
    ]));
  }

  function buildTelemetry(overrides = {}) {
    db.seq += 1;
    const posture = overrides.posture || profiles[(db.seq - 1) % profiles.length].posture;
    const profile = profiles.find((item) => item.posture === posture) || profiles[0];
    const pressure = {...profile.pressure, ...(overrides.pressure || {})};
    const rawPressure = {...rawPressureFromNormalized(pressure), ...(overrides.raw_pressure || {})};
    const warning = overrides.warning_active ?? !["normal", "empty"].includes(posture);
    const device = db.devices.find((item) => item.device_id === (overrides.device_id || "SG-0001"));
    const batteryLevel = Object.prototype.hasOwnProperty.call(overrides, "battery_level")
      ? overrides.battery_level
      : device?.battery_level ?? null;
    return {
      protocol_version: 2,
      device_id: overrides.device_id || "SG-0001",
      device_name: overrides.device_name || device?.device_name || "SpineGuard Mock",
      student_id: overrides.student_id || "STU-MOCK-001",
      session_id: overrides.session_id || "S-MOCK-WEB-001",
      seq: overrides.seq ?? db.seq,
      timestamp_ms: overrides.timestamp_ms || Date.now(),
      occupied: overrides.occupied ?? posture !== "empty",
      ratio_valid: overrides.ratio_valid ?? posture !== "empty",
      posture,
      confidence: overrides.confidence ?? profile.confidence,
      pressure,
      raw_pressure: rawPressure,
      pressure_features: overrides.pressure_features || features(pressure),
      imu: {...profile.imu, ...(overrides.imu || {})},
      backrest: overrides.backrest || {online: true, data_ready: true, valid: posture !== "empty", distance_mm: posture === "empty" ? null : 92, range_status: 0},
      posture_duration_s: overrides.posture_duration_s ?? db.seq * 2,
      sitting_duration_s: overrides.sitting_duration_s ?? db.seq * 2,
      vibration_enabled: overrides.vibration_enabled ?? true,
      vibration_effective_enabled: overrides.vibration_effective_enabled ?? true,
      warning_active: warning,
      reminder_due: overrides.reminder_due ?? false,
      reminder_suppressed: overrides.reminder_suppressed ?? false,
      vibration_active: overrides.vibration_active ?? warning,
      vibration_position: overrides.vibration_position ?? ({left_lean: "left", right_lean: "right", front_lean: "front", back_lean: "back"}[posture] || null),
      reminder_count: overrides.reminder_count ?? Math.floor(db.seq / 4),
      reminder_cooldown_remaining_s: overrides.reminder_cooldown_remaining_s ?? 0,
      reminder_config: overrides.reminder_config || {
        mode: device?.reminder?.mode || "normal",
        trigger_duration_s: device?.reminder?.trigger_duration_s || 300,
        vibration_duration_s: device?.reminder?.vibration_duration_s || 10,
        cooldown_s: device?.reminder?.cooldown_s || 600,
        intensity_percent: device?.reminder?.intensity_percent || 40,
      },
      applied_config_version: overrides.applied_config_version ?? device?.applied_config_version ?? 1,
      battery_level: batteryLevel,
      power_source: overrides.power_source || "power_bank",
      wifi_rssi_dbm: overrides.wifi_rssi_dbm ?? -52,
      sensor_status: overrides.sensor_status || device?.sensor_status || null,
      command_status: overrides.command_status || {id: null, type: "none", status: "idle", progress_percent: 0, error: null},
      device_credential_mode: "per_device_secret",
      recognition_source: "mock",
      model_version: "mock-lightgbm-v2",
      firmware_version: "0.5.0-device-management",
    };
  }

  function uploadTelemetry(overrides = {}) {
    const telemetry = buildTelemetry(overrides);
    db.telemetry.push(telemetry);
    if (db.telemetry.length > 500) db.telemetry = db.telemetry.slice(-500);
    const device = db.devices.find((item) => item.device_id === telemetry.device_id);
    if (device) Object.assign(device, {battery_level: telemetry.battery_level, online_status: "online", last_seen_at: nowIso(), firmware_version: telemetry.firmware_version});
    save();
    return clone(telemetry);
  }

  function localHourTimestamp(hour, minute = 20) {
    const value = new Date();
    value.setHours(hour, minute, 0, 0);
    return value.getTime();
  }

  function historicalPosture(studentIndex, bucketIndex) {
    const thresholds = [26, 24, 10, 19, 22];
    const emptyStarts = [29, 30, 14, 30, 29];
    if (studentIndex < thresholds[bucketIndex]) return "normal";
    if (studentIndex >= emptyStarts[bucketIndex]) return "empty";
    return ["left_lean", "right_lean", "front_lean", "back_lean"][(studentIndex + bucketIndex) % 4];
  }

  function seedTelemetry() {
    const hours = [8, 10, 12, 14, 16];
    mockStudents.forEach((student, studentIndex) => {
      const device = db.devices.find((item) => item.student_id === student.student_id);
      hours.forEach((hour, bucketIndex) => {
        db.telemetry.push(buildTelemetry({
          student_id: student.student_id,
          device_id: device?.device_id,
          posture: historicalPosture(studentIndex, bucketIndex),
          timestamp_ms: localHourTimestamp(hour, 15 + studentIndex % 30),
          sitting_duration_s: 1800 + bucketIndex * 1500 + studentIndex * 11,
          reminder_count: Math.floor(scenarioFor(student.student_id).reminderCount * (bucketIndex + 1) / hours.length),
          battery_level: device?.battery_level,
        }));
      });
      const scenario = scenarioFor(student.student_id);
      db.telemetry.push(buildTelemetry({
        student_id: student.student_id,
        device_id: device?.device_id,
        posture: scenario.posture,
        timestamp_ms: scenario.online ? Date.now() - (studentIndex % 8) * 700 : new Date(device?.last_seen_at || Date.now()).getTime(),
        sitting_duration_s: scenario.totalSittingSeconds,
        reminder_count: scenario.reminderCount,
        battery_level: device?.battery_level,
      }));
    });
    db.telemetry = db.telemetry.slice(-500);
    save();
  }

  if (!db.telemetry.length) seedTelemetry();

  function latestForStudent(studentId) {
    const boundDeviceId = db.devices.find((item) => item.student_id === studentId)?.device_id;
    return [...db.telemetry].reverse().find((item) => item.student_id === studentId && (!boundDeviceId || item.device_id === boundDeviceId)) || null;
  }

  function latestForDevice(deviceId) {
    return [...db.telemetry].reverse().find((item) => item.device_id === deviceId) || null;
  }

  function dateText() { return new Date().toISOString().slice(0, 10); }

  function offsetDate(dateValue, days) {
    const value = new Date(`${dateValue}T12:00:00`);
    value.setDate(value.getDate() + days);
    return value.toISOString().slice(0, 10);
  }

  function dailyStatFor(studentId, date) {
    const scenario = scenarioFor(studentId);
    const today = dateText();
    const ratio = date === today ? scenario.normalRatio : scenario.previousRatio;
    const total = Math.round(scenario.totalSittingSeconds * (date === today ? 1 : .92));
    const normal = Math.round(total * ratio);
    const poor = total - normal;
    const abnormalEvents = Math.max(1, Math.round((1 - ratio) * 42));
    const front = Math.round(abnormalEvents * (.34 + (scenario.index % 3) * .04));
    const left = Math.round(abnormalEvents * .27);
    const right = Math.round(abnormalEvents * .22);
    const back = Math.max(0, abnormalEvents - front - left - right);
    return {
      student_id: studentId,
      stat_date: date,
      total_sitting_s: total,
      normal_sitting_s: normal,
      poor_sitting_s: poor,
      normal_ratio: ratio,
      left_lean_count: left,
      right_lean_count: right,
      front_lean_count: front,
      back_lean_count: back,
      reminder_count: scenario.reminderCount,
      avg_asymmetry_index: scenario.asymmetry,
      max_poor_posture_duration_s: scenario.riskLevel === "red" ? 360 + scenario.index * 3 : scenario.riskLevel === "yellow" ? 145 + scenario.index * 2 : 45 + scenario.index,
    };
  }

  function riskFor(studentId) {
    const scenario = scenarioFor(studentId);
    const reasons = scenario.riskLevel === "red"
      ? ["近 7 天非标准坐姿占比较高", "单次非标准坐姿持续时间较长"]
      : scenario.riskLevel === "yellow"
        ? [scenario.asymmetry >= .27 ? "近 7 天压力不对称指数略高" : "近 7 天存在一定非标准坐姿占比"]
        : ["近 7 天未发现明显持续异常坐姿行为"];
    const suggestion = scenario.riskLevel === "red"
      ? "坐姿行为风险较高，建议班主任优先关注并增加休息提醒。"
      : scenario.riskLevel === "yellow"
        ? "存在一定坐姿行为风险，建议关注坐姿习惯并定时活动。"
        : "坐姿行为风险较低，建议继续保持良好坐姿习惯。";
    return {
      student_id: studentId,
      period_start: offsetDate(dateText(), -6),
      period_end: dateText(),
      risk_level: scenario.riskLevel,
      risk_score: scenario.riskScore,
      risk_reasons: reasons,
      suggestion,
      consecutive_days: scenario.consecutiveDays,
      trend: scenario.trend,
    };
  }

  function stageTasks(scenario) {
    const normal = Math.round(scenario.totalSittingSeconds * scenario.normalRatio);
    return [
      {task_id: "daily_normal_30", progress: Math.min(normal, 1800), target: 1800, status: normal >= 1800 ? "claimable" : "locked", reward: {water: 6}},
      {task_id: "continuous_25", progress: Math.min(Math.round(normal * .42), 1500), target: 1500, status: normal >= 3600 ? "claimable" : "locked", reward: {sunshine: 3, water: 3}},
      {task_id: "daily_reminder_lt_5", progress: Math.min(scenario.totalSittingSeconds, 1800), target: 1800, status: scenario.reminderCount < 5 ? "claimable" : "locked", reward: {nutrient: 3}},
      {task_id: "active_rest_after_60", progress: scenario.totalSittingSeconds >= 3600 ? 3600 : scenario.totalSittingSeconds, target: 3600, status: scenario.index % 4 === 0 ? "claimed" : "locked", reward: {sunshine: 2}},
    ];
  }

  const api = {
    mode: "mock",
    apiBase: "localStorage://sg.mock.database.v1",
    getToken: () => sessionStorage.getItem("sg.access_token") || "",
    setToken: (token) => token ? sessionStorage.setItem("sg.access_token", token) : sessionStorage.removeItem("sg.access_token"),
    health: () => ok({status: "ok", version: "mock-v1"}),
    register(data) {
      if (db.users.some((item) => item.username === data.username)) return fail("Username already exists", 409);
      const user = {user_id: `USR-MOCK-${Date.now()}`, username: data.username, password: data.password, role: data.role};
      db.users.push(user); save();
      return ok({ok: true, data: publicUser(user)});
    },
    login(username, password) {
      const user = db.users.find((item) => item.username === username && item.password === password);
      if (!user) return fail("Invalid username or password", 401);
      return ok({access_token: `mock:${username}`, token_type: "bearer", user: publicUser(user)});
    },
    me() {
      const user = tokenUser();
      return user ? ok({ok: true, data: publicUser(user)}) : fail("Not authenticated", 401);
    },
    students: () => ok({ok: true, items: clone(visibleStudents()), total: visibleStudents().length}),
    createStudent(data) {
      const user = tokenUser();
      if (!user) return fail("Not authenticated", 401);
      const student = {student_id: `STU-MOCK-${Date.now()}`, display_code: data.display_code, school_id: data.school_id, class_id: data.class_id, owner: user.user_id};
      db.students.push(student); save();
      return ok({ok: true, data: clone(student)});
    },
    devices: () => ok({ok: true, items: clone(visibleDevices()), total: visibleDevices().length}),
    bindDevice(data) {
      const user = tokenUser();
      const device = db.devices.find((item) => item.device_id === data.device_id);
      if (!device) return fail("Device not found", 404);
      const student = db.students.find((item) => item.student_id === data.student_id);
      if (!student) return fail("Student not found", 404);
      if (user?.role === "parent" && student.owner !== user.user_id) return fail("Insufficient permissions", 403);
      db.devices.forEach((item) => {
        if (item.device_id !== device.device_id && item.student_id === data.student_id) item.student_id = null;
      });
      device.student_id = data.student_id; save();
      return ok({ok: true, data: {device_id: data.device_id, student_id: data.student_id, active: true, bound_by_user_id: tokenUser()?.user_id}});
    },
    pairDevice(data) {
      const user = tokenUser();
      const student = db.students.find((item) => item.student_id === data.student_id);
      if (!student) return fail("Student not found", 404);
      if (user?.role === "parent" && student.owner !== user.user_id) return fail("Insufficient permissions", 403);
      if (!/^\d{6}$/.test(String(data.claim_code || ""))) return fail("绑定码必须是六位数字", 422);
      const device = db.devices.find((item) => item.device_id === data.device_id);
      if (device && data.claim_code !== "123456") return fail("Invalid claim code", 400);
      const now = Date.now();
      const pairing = {
        pairing_id: `PAIR-MOCK-${now}`,
        device_id: data.device_id,
        student_id: data.student_id,
        status: device ? "completed" : "pending",
        expires_at: new Date(now + 10 * 60 * 1000).toISOString(),
        completed_at: device ? new Date(now).toISOString() : null,
        binding: null,
        message: device ? "Device binding completed" : "Waiting for the device to connect and register",
      };
      if (device) {
        db.devices.forEach((item) => {
          if (item.device_id !== device.device_id && item.student_id === data.student_id) item.student_id = null;
        });
        device.student_id = data.student_id;
        pairing.binding = {device_id: device.device_id, student_id: data.student_id, active: true, bound_by_user_id: user?.user_id};
      }
      db.pairings.push(pairing);
      save();
      return ok({ok: true, data: clone(pairing)});
    },
    pairingStatus(pairingId) {
      const pairing = db.pairings.find((item) => item.pairing_id === pairingId);
      if (!pairing) return fail("Pairing request not found", 404);
      if (pairing.status === "pending" && Date.parse(pairing.expires_at) <= Date.now()) {
        pairing.status = "expired";
        pairing.message = "Pairing request expired; please reconnect to the device hotspot";
        save();
      }
      return ok({ok: true, data: clone(pairing)});
    },
    cancelPairing(pairingId) {
      const pairing = db.pairings.find((item) => item.pairing_id === pairingId);
      if (!pairing) return fail("Pairing request not found", 404);
      if (pairing.status === "pending") {
        pairing.status = "cancelled";
        pairing.message = "Pairing request cancelled";
        save();
      }
      return ok({ok: true, data: clone(pairing)});
    },
    deviceStatus(deviceId) {
      const device = db.devices.find((item) => item.device_id === deviceId);
      return device ? ok({ok: true, data: clone(device)}) : fail("Device not found", 404);
    },
    deviceConfig(deviceId) {
      const device = db.devices.find((item) => item.device_id === deviceId);
      if (!device) return fail("Device not found", 404);
      const reminder = device.reminder || {enabled: true, mode: "normal", trigger_duration_s: 300, vibration_duration_s: 10, cooldown_s: 600, intensity_percent: 40};
      return ok({ok: true, data: {
        config_version: device.config_version || 0,
        device_name: device.device_name || device.device_id,
        reminder: clone(reminder),
        command: null,
      }});
    },
    updateDeviceConfig(deviceId, changes) {
      const device = db.devices.find((item) => item.device_id === deviceId);
      if (!device) return fail("Device not found", 404);
      device.reminder ||= {enabled: true, mode: "normal", trigger_duration_s: 300, vibration_duration_s: 10, cooldown_s: 600, intensity_percent: 40};
      if (changes.device_name) device.device_name = changes.device_name;
      const reminderMap = {
        enabled: "enabled",
        mode: "mode",
        trigger_duration_s: "trigger_duration_s",
        vibration_duration_s: "vibration_duration_s",
        cooldown_s: "cooldown_s",
        intensity_percent: "intensity_percent",
      };
      Object.entries(reminderMap).forEach(([source, target]) => {
        if (changes[source] !== undefined && changes[source] !== null) device.reminder[target] = changes[source];
      });
      device.config_version = Number(device.config_version || 0) + 1;
      device.applied_config_version = device.config_version;
      save();
      return this.deviceConfig(deviceId);
    },
    deviceLatest(deviceId) { return ok({ok: true, data: clone(latestForDevice(deviceId))}); },
    studentLatest(studentId) {
      const device = db.devices.find((item) => item.student_id === studentId);
      const scenario = scenarioFor(studentId);
      const latest = scenario.online
        ? uploadTelemetry({student_id: studentId, device_id: device?.device_id || "SG-0001", posture: scenario.posture, timestamp_ms: Date.now(), sitting_duration_s: scenario.totalSittingSeconds, reminder_count: scenario.reminderCount, battery_level: device?.battery_level})
        : latestForStudent(studentId);
      return ok({ok: true, data: clone(latest)});
    },
    studentHistory(studentId, params = {}) {
      const limit = Math.min(Number(params.limit) || 100, 2000);
      let items = db.telemetry.filter((item) => item.student_id === studentId);
      const start = params.from ? Date.parse(params.from) : null;
      const end = params.to ? Date.parse(params.to) : null;
      if (Number.isFinite(start)) items = items.filter((item) => item.timestamp_ms >= start);
      if (Number.isFinite(end)) items = items.filter((item) => item.timestamp_ms <= end);
      return ok({ok: true, items: clone(items.slice(-limit))});
    },
    dailyStats: (studentId, date) => ok({ok: true, data: clone(dailyStatFor(studentId, date))}),
    weeklyStats(studentId, week) {
      const scenario = scenarioFor(studentId);
      const currentMonday = (() => { const value = new Date(); const day = value.getDay() || 7; value.setDate(value.getDate() - day + 1); return value.toISOString().slice(0, 10); })();
      const ratio = week === currentMonday ? scenario.normalRatio : scenario.previousRatio;
      const dailyItems = Array.from({length: 7}, (_, index) => ({...dailyStatFor(studentId, offsetDate(week, index)), normal_ratio: clamp(ratio + ((index % 3) - 1) * .01, .4, .97)}));
      return ok({ok: true, data: {...dailyStatFor(studentId, dateText()), normal_ratio: ratio, week, period_start: week, period_end: offsetDate(week, 6), daily_items: dailyItems}});
    },
    risk: (studentId) => ok({ok: true, data: clone(riskFor(studentId))}),
    reports(studentId) { const items = db.reports.filter((item) => item.student_id === studentId); return ok({ok: true, items: clone(items), total: items.length}); },
    reportDetail(studentId, reportId) {
      const report = db.reports.find((item) => item.student_id === studentId && Number(item.report_id) === Number(reportId));
      return report ? ok({ok: true, data: clone(report)}) : fail("Report not found", 404);
    },
    generateReport(studentId, data) {
      const endDate = data.date || dateText();
      const type = data.report_type || "smart";
      const days = type === "monthly" ? 29 : type === "weekly" ? 6 : type === "smart" ? 5 : 0;
      const risk = riskFor(studentId);
      const student = db.students.find((item) => item.student_id === studentId);
      const summary = mockReportSummary(studentId, Number(data.record_limit || 600));
      const content = type === "smart"
        ? `# 青少年坐姿行为智能筛查报告

**分析对象**：${student?.display_code || studentId}  
**数据范围**：最近 ${summary.record_count} 条有效坐姿记录

---

### 1. 整体坐姿表现

* **标准坐姿比例**：${Math.round(summary.normal_ratio * 100)}%
* **有效坐姿时长**：${Math.round(summary.effective_sitting_s / 60)} 分钟
* **坐姿提醒次数**：${summary.reminder_count} 次

### 2. 趋势判断

本轮坐姿整体保持稳定，建议继续关注连续非标准坐姿的持续时间。

### 3. 日常纠正建议

1. **保持规律休息**：连续学习 30～40 分钟后短时起身活动。
2. **调整就坐位置**：保持身体位于坐垫中央，减少单侧压力集中。
3. **持续观察**：${risk.suggestion}

> 本报告用于坐姿行为筛查参考，不作为医学诊断依据。`
        : `${student?.display_code || studentId}在本次分析中标准坐姿率约为 ${Math.round(summary.normal_ratio * 100)}%，有效坐姿 ${Math.round(summary.effective_sitting_s / 60)} 分钟，共记录 ${summary.reminder_count} 次提醒。${risk.suggestion}`;
      const report = {report_id: Math.max(0, ...db.reports.map((item) => Number(item.report_id || 0))) + 1, student_id: studentId, report_type: type, period_start: offsetDate(endDate, -days), period_end: endDate, summary, content, generated_by: type === "smart" || data.use_llm ? "mock_llm" : "mock_rule", created_at: nowIso()};
      db.reports.unshift(report); save();
      return ok({ok: true, data: clone(report)});
    },
    notifications(unreadOnly = false) { const items = db.notifications.filter((item) => item.user_id === tokenUser()?.user_id && (!unreadOnly || !item.is_read)); return ok({ok: true, items: clone(items), total: items.length}); },
    readNotification(id) { const item = db.notifications.find((entry) => entry.notification_id === id); if (item) {item.is_read = true; item.read_at = nowIso(); save();} return ok({ok: true, data: clone(item)}); },
    adminOverview: () => {
      const ratios = db.students.map((item) => scenarioFor(item.student_id).normalRatio);
      const red = db.students.filter((item) => scenarioFor(item.student_id).riskLevel === "red").length;
      return ok({ok: true, data: {student_count: db.students.length, device_count: db.devices.length, active_device_count: db.devices.filter((item) => item.online_status === "online").length, average_normal_ratio: ratios.reduce((sum, value) => sum + value, 0) / ratios.length, high_risk_student_count: red, class_summaries: []}});
    },
    adminClasses: () => {
      const classStudents = db.students.filter((item) => item.class_id === CLASS_ID);
      const classDevices = db.devices.filter((item) => classStudents.some((student) => student.student_id === item.student_id));
      const average = classStudents.reduce((sum, item) => sum + scenarioFor(item.student_id).normalRatio, 0) / classStudents.length;
      return ok({ok: true, items: [{class_id: CLASS_ID, student_count: classStudents.length, device_count: classDevices.length, online_device_count: classDevices.filter((item) => item.online_status === "online").length, average_normal_ratio: average, high_risk_student_count: classStudents.filter((item) => scenarioFor(item.student_id).riskLevel === "red").length}], total: 1});
    },
    adminClassStudents(classId) {
      const items = db.students.filter((item) => (item.class_id || "unassigned") === classId).map((item) => {
        const scenario = scenarioFor(item.student_id);
        return {...item, average_normal_ratio: scenario.normalRatio, total_sitting_s: scenario.totalSittingSeconds, reminder_count: scenario.reminderCount, risk_level: scenario.riskLevel, risk_score: scenario.riskScore};
      });
      return ok({ok: true, items: clone(items), total: items.length});
    },
    adminRiskStudents(riskLevel = "all") {
      const items = db.students.map((student) => ({...student, ...riskFor(student.student_id)})).filter((item) => riskLevel === "all" || item.risk_level === riskLevel);
      return ok({ok: true, items: clone(items), total: items.length});
    },
    studentGarden(studentId) {
      const scenario = scenarioFor(studentId);
      const normalSeconds = Math.round(scenario.totalSittingSeconds * scenario.normalRatio);
      return ok({ok: true, data: {growth: scenario.growth, stage: scenario.stage, resources: {sunshine: 5 + scenario.index % 14, water: 8 + scenario.index % 18, nutrient: 2 + scenario.index % 8}, today_normal_s: normalSeconds, continuous_normal_s: Math.min(1800, Math.round(normalSeconds * .38)), reminder_count: scenario.reminderCount, reminder_rate_30m: Math.round(scenario.reminderCount / Math.max(1, scenario.totalSittingSeconds / 1800)), daily_growth_granted: Math.min(180, Math.round(normalSeconds / 60)), daily_growth_remaining: Math.max(0, 180 - Math.round(normalSeconds / 60)), device_online: scenario.online, instant_tree_state: scenario.posture, recovery_needed: scenario.riskLevel === "red", tasks: stageTasks(scenario), rule_version: "garden-v1-mock", server_time: nowIso(), updated_at: nowIso()}});
    },
    downloadAdminRiskExport: () => ok({ok: true, message: "Mock 模式不生成真实导出文件"}),
    uploadTelemetry,
    simulateTelemetry: uploadTelemetry,
    reset() { localStorage.removeItem(DB_KEY); db = clone(initialDb); save(); location.reload(); },
    snapshot: () => clone(db),
  };

  const queryMode = new URLSearchParams(location.search).get("mode");
  const configuredMode = global.SPINEGUARD_CONFIG?.mode || (global.SPINEGUARD_CONFIG?.useMock === false ? "api" : "mock");
  const mockEnabled = (queryMode === "mock" || queryMode === "api" ? queryMode : configuredMode) === "mock";
  if (mockEnabled) {
    const interval = Number(global.SPINEGUARD_CONFIG?.mockTelemetryIntervalMs) || 2200;
    global.setInterval(() => uploadTelemetry(), interval);
  }

  global.SpineGuardMockApi = api;
})(window);
