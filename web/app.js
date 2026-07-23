const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));
const safeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]);
const reportTypeLabels = { smart: "智能报告", daily: "日报", weekly: "周报", monthly: "月报" };
const reportSourceLabels = { rule: "规则生成", llm: "智能生成", llm_fallback: "智能失败 · 规则兜底", mock_rule: "规则生成", mock_llm: "智能生成" };
const reportPostureLabels = { normal: "标准坐姿", left_lean: "左倾", right_lean: "右倾", front_lean: "前倾", back_lean: "后仰" };
const reportTrendLabels = { improving: "正在改善", worsening: "需要关注", stable: "基本稳定", insufficient_data: "数据不足" };
const beijingDateText = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
const sessionStore = window.sessionStorage;

// 登录态必须属于当前标签页，否则同域的后一次登录会覆盖其他标签页。
// 首次升级时仅把旧 localStorage 会话迁移给当前标签页，然后删除共享副本。
for (const key of ["sg.access_token", "sg.user"]) {
  const legacyValue = localStorage.getItem(key);
  if (sessionStore.getItem(key) === null && legacyValue !== null) sessionStore.setItem(key, legacyValue);
  if (legacyValue !== null) localStorage.removeItem(key);
}

function storedJson(key) {
  try {
    return JSON.parse(sessionStore.getItem(key) || "null");
  } catch {
    return null;
  }
}

function userFromAccessToken(token) {
  if (!token || token.startsWith("mock:")) return null;
  try {
    const payloadPart = token.split(".")[1];
    if (!payloadPart) return null;
    const normalized = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")));
    if (!payload.sub || !payload.role || Number(payload.exp || 0) * 1000 <= Date.now()) return null;
    return {user_id: payload.sub, username: payload.username || payload.sub, role: frontendRole(payload.role)};
  } catch {
    return null;
  }
}

const storedToken = sessionStore.getItem("sg.access_token") || "";
const storedUser = storedJson("sg.user");
const tokenUser = userFromAccessToken(storedToken);
const storedTokenLooksLikeJwt = storedToken.split(".").length === 3;
const cachedSessionUser = tokenUser
  ? {
      ...(storedUser?.user_id === tokenUser.user_id && frontendRole(storedUser.role) === tokenUser.role ? storedUser : {}),
      ...tokenUser,
    }
  : (storedTokenLooksLikeJwt ? null : storedUser);

const state = {
  user: cachedSessionUser,
  token: storedToken,
  authMode: "login",
  tick: 0,
  posture: null,
  trend: [],
  latestSeat: [],
  notificationsUnread: true,
  notifications: [],
  reports: [],
  activeReport: null,
  students: [],
  devices: [],
  currentStudentId: sessionStore.getItem(cachedSessionUser?.user_id
    ? `sg.student_id.${cachedSessionUser.user_id}`
    : "sg.student_id") || "",
  currentDeviceId: sessionStore.getItem("sg.device_id") || "SG-0001",
  latestTelemetry: null,
  backendError: "",
  adminOverview: null,
  exerciseContext: null,
  exerciseSelectedId: "cat_breath",
  exerciseCategory: "全部",
  deviceBindingMessage: "",
  deviceBindingMessageType: "",
  pendingPairing: storedJson("sg.pending_pairing"),
  profilePanel: "account",
  activeTab: "",
};

// v1 乐园缓存包含已废弃字段，升级后不再保留。
localStorage.removeItem("sg.garden.mock");

const pressureSensors = [
  { key: "left", label: "左侧", x: 0.2, y: 0.5 },
  { key: "right", label: "右侧", x: 0.8, y: 0.5 },
  { key: "front", label: "前侧", x: 0.5, y: 0.2 },
  { key: "back", label: "后侧", x: 0.5, y: 0.8 },
  { key: "center", label: "中心", x: 0.5, y: 0.5 },
];

let seatScene = null;
let liveSocket = null;
let liveSocketConnected = false;
let liveSocketReconnectTimer = null;
let gameSocket = null;
let livePollTimer = null;
let livePollDelay = 2200;
let pairingPollTimer = null;

const gardenStages = [
  { name: "种子期", min: 0, next: 100 },
  { name: "幼苗期", min: 100, next: 300 },
  { name: "小树期", min: 300, next: 600 },
  { name: "大树期", min: 600, next: 1000 },
  { name: "开花期", min: 1000, next: 1500 },
  { name: "结果期", min: 1500, next: Infinity },
];

const defaultGardenState = {
  growth: 486,
  fruits: 0,
  resources: { sunshine: 12, water: 18, nutrient: 6 },
  dailyCorrectMinutes: 26,
  continuousCorrectMinutes: 12,
  reminderCount: 3,
  plan: { sunbathe: 0, water: 0, fertilize: 0, recover_tree: 0 },
  tasks: [
    { id: "daily_normal_30", name: "今日正确坐姿累计 30 分钟", progress: 26, target: 30, unit: "分钟", reward: "水滴 +6", status: "locked" },
    { id: "continuous_25", name: "连续正确坐姿 25 分钟", progress: 12, target: 25, unit: "分钟", reward: "阳光 +3 · 水滴 +3", status: "locked" },
    { id: "daily_reminder_lt_5", name: "有效就坐 30 分钟且提醒少于 5 次", progress: 26, target: 30, unit: "分钟", reward: "营养 +3", status: "locked" },
    { id: "active_rest_after_60", name: "学习满 60 分钟后主动休息", progress: 0, target: 5, unit: "分钟", reward: "阳光 +2", status: "locked" },
  ],
  transactions: [
    ["今天 14:35", "连续正确 15 分钟", "+3", "0", "0", "0"],
    ["今天 13:10", "浇水", "0", "-5", "0", "+15"],
    ["今天 12:48", "检测到前倾", "0", "0", "0", "0"],
    ["昨天 19:20", "主动离座休息", "+2", "0", "0", "0"],
  ],
};

const gardenState = structuredClone(defaultGardenState);
if (SpineGuardGardenService.mode === "api") {
  Object.assign(gardenState, {
    growth: 0, resources: { sunshine: 0, water: 0, nutrient: 0 }, dailyCorrectMinutes: 0,
    continuousCorrectMinutes: 0, reminderCount: 0, tasks: [], transactions: [],
  });
}
let gardenLoadError = "";
let gardenBusy = false;
let gardenView = "home";
let gardenTreeController = null;
let focusTreeController = null;
let focusSession = null;
let adminWorkspace = null;

function getAdminWorkspace() {
  if (!adminWorkspace && window.SpineGuardAdminWorkspace) {
    adminWorkspace = new window.SpineGuardAdminWorkspace(SpineGuardApi, { toast: showGardenToast });
  }
  return adminWorkspace;
}

const gardenApi = {
  async load() {
    try {
      applyGardenViewModel(await SpineGuardGardenService.getGarden(state.currentStudentId));
      gardenLoadError = "";
      try {
        const ledger = await SpineGuardGardenService.getRewardLedger(state.currentStudentId);
        if (Array.isArray(ledger?.items)) gardenState.transactions = ledger.items.map((item) => [
          new Date(item.created_at).toLocaleString("zh-CN", { hour12: false }), item.source_type,
          signed(item.sunshine_delta), signed(item.water_delta), signed(item.nutrient_delta), signed(item.growth_delta),
        ]);
      } catch (error) { console.warn("奖励流水同步失败", error); }
    } catch (error) {
      gardenLoadError = error.message;
    }
    return gardenState;
  },
  adjustPlan(action, delta) {
    gardenState.plan[action] = clamp(gardenState.plan[action] + delta, 0, action === "recover_tree" ? 1 : 5);
  },
  async executePlan() {
    const actions = Object.entries(gardenState.plan).filter(([, count]) => count > 0);
    if (!actions.length) throw new Error("请先选择照顾操作");
    let latest;
    for (const [action, count] of actions) latest = await SpineGuardGardenService.useResource(state.currentStudentId, action, count);
    applyGardenViewModel(latest);
    gardenState.plan = { sunbathe: 0, water: 0, fertilize: 0, recover_tree: 0 };
    return latest;
  },
  async claimTask(taskId) {
    applyGardenViewModel(await SpineGuardGardenService.claimTask(state.currentStudentId, taskId));
  },
};

function rewardText(reward) {
  return [["阳光", reward.sunshine], ["水滴", reward.water], ["营养", reward.nutrient]]
    .filter(([, value]) => value > 0).map(([name, value]) => `${name} +${value}`).join(" · ");
}

function signed(value) {
  const number = Number(value || 0);
  return number > 0 ? `+${number}` : String(number);
}

function applyGardenViewModel(vm) {
  if (!vm) return;
  gardenState.growth = vm.growth;
  gardenState.resources = { ...vm.resources };
  gardenState.dailyCorrectMinutes = Math.floor(vm.todayNormalSeconds / 60);
  gardenState.continuousCorrectMinutes = Math.floor(vm.continuousNormalSeconds / 60);
  gardenState.reminderCount = vm.reminderCount;
  gardenState.reminderRate30m = vm.reminderRate30m;
  gardenState.instantTreeState = vm.instantTreeState;
  gardenState.recoveryNeeded = vm.recoveryNeeded;
  gardenState.ruleVersion = vm.ruleVersion;
  gardenState.updatedAt = vm.updatedAt;
  gardenState.tasks = vm.tasks.map((task) => ({
    id: task.taskId, name: task.title, progress: task.progress, target: task.target,
    unit: task.unit, status: task.status, reward: rewardText(task.reward),
  }));
}

const roleConfig = {
  parent: {
    label: "家长用户",
    workspace: "家长端健康工作台",
    startTab: "monitor",
    nav: [
      ["monitor", "实时坐姿"],
      ["reports", "健康报告"],
      ["game", "坐姿种树"],
      ["exercise", "护脊训练"],
    ],
  },
  admin: {
    label: "学校管理员",
    workspace: "学校端管理工作台",
    startTab: "dashboard",
    nav: [
      ["dashboard", "班级管理"],
      ["school", "风险中心"],
      ["devices", "设备管理"],
      ["admin-reports", "报告中心"],
    ],
  },
};

const postures = [
  { id: 0, name: "标准坐姿", desc: "坐垫受力对称，靠背接触稳定。", risk: "低风险", riskClass: "risk-green", vibration: "未触发", seatLabel: "左右均衡", backLabel: "均匀接触" },
  { id: 1, name: "左倾坐姿", desc: "左侧臀区压力明显高于右侧，建议调整坐姿中心。", risk: "中风险", riskClass: "risk-yellow", vibration: "观察中", seatLabel: "左侧偏高", backLabel: "左背偏高" },
  { id: 2, name: "右倾坐姿", desc: "右侧臀区压力明显高于左侧，可能存在长期单侧负荷。", risk: "中风险", riskClass: "risk-yellow", vibration: "观察中", seatLabel: "右侧偏高", backLabel: "右背偏高" },
  { id: 3, name: "前倾 / 趴写", desc: "大腿区压力上升，靠背压力下降，疑似身体前倾。", risk: "中风险", riskClass: "risk-yellow", vibration: "已触发", seatLabel: "前侧偏高", backLabel: "接触不足" },
  { id: 4, name: "后仰 / 瘫坐", desc: "靠背下部压力集中，坐骨区受力不稳定。", risk: "低风险", riskClass: "risk-green", vibration: "已触发", seatLabel: "后侧偏高", backLabel: "下背集中" },
  { id: 5, name: "暂时无法识别", desc: "当前数据不足以稳定识别，请坐稳后继续观察。", risk: "待确认", riskClass: "risk-yellow", vibration: "观察中", seatLabel: "分布不稳定", backLabel: "待确认" },
  { id: 6, name: "无人就坐", desc: "坐垫当前没有检测到有效压力。", risk: "无评估", riskClass: "risk-green", vibration: "未触发", seatLabel: "无压力", backLabel: "无接触" },
];

const postureCodeToId = {
  normal: 0,
  left_lean: 1,
  right_lean: 2,
  front_lean: 3,
  back_lean: 4,
  unknown: 5,
  empty: 6,
};

function frontendRole(role) {
  return role === "school_admin" || role === "doctor" || role === "admin" ? "admin" : "parent";
}

function backendRole(role) {
  return role === "admin" ? "school_admin" : "parent";
}

function studentStorageKey(userId = state.user?.user_id) {
  return userId ? `sg.student_id.${userId}` : "sg.student_id";
}

function persistCurrentStudent() {
  const key = studentStorageKey();
  if (state.currentStudentId) {
    sessionStore.setItem(key, state.currentStudentId);
    sessionStore.setItem("sg.student_id", state.currentStudentId);
  } else {
    sessionStore.removeItem(key);
    sessionStore.removeItem("sg.student_id");
  }
}

function applyAccessibleStudents(items, preferredStudentId = "") {
  state.students = Array.isArray(items) ? items : [];
  const accessibleIds = new Set(state.students.map((item) => item.student_id));
  const scopedStudentId = sessionStore.getItem(studentStorageKey()) || "";
  const legacyStudentId = state.user?.user_id ? "" : (sessionStore.getItem("sg.student_id") || "");
  state.currentStudentId = [preferredStudentId, state.currentStudentId, scopedStudentId, legacyStudentId]
    .find((studentId) => studentId && accessibleIds.has(studentId))
    || state.students[0]?.student_id
    || "";
  persistCurrentStudent();
  return state.currentStudentId;
}

async function resolveCurrentStudent(preferredStudentId = "") {
  if (!state.token || !state.user) return "";
  const result = await SpineGuardApi.students();
  return applyAccessibleStudents(result.items, preferredStudentId);
}

function mapTelemetry(raw) {
  if (!raw) return null;
  const vm = SpineGuardModels.mapTelemetry(raw);
  const posture = postures[postureCodeToId[vm.postureCode] ?? 5];
  const pressure = vm.pressure;
  return {
    ...vm,
    posture,
    pressure,
    pressurePoints: pressureSensors.map((sensor) => ({
      ...sensor,
      value: pressure[sensor.key],
    })),
    asymmetry: vm.pressureFeatures.asymmetryIndex,
    durationSeconds: vm.postureDurationSeconds,
    sittingSeconds: vm.sittingDurationSeconds,
  };
}

async function loadUserContext() {
  if (!state.token) return;
  const [studentResult, deviceResult] = await Promise.all([
    SpineGuardApi.students(),
    SpineGuardApi.devices(),
  ]);
  applyAccessibleStudents(studentResult.items);
  state.devices = deviceResult.items || [];
  if (state.devices[0] && (!state.currentDeviceId || !state.devices.some((item) => item.device_id === state.currentDeviceId))) {
    state.currentDeviceId = state.devices[0].device_id;
  }
  if (state.user?.role === "parent" && !state.devices.length) state.currentDeviceId = "";
  sessionStore.setItem("sg.device_id", state.currentDeviceId);
  await gardenApi.load();
  if ($("#garden-view")) renderGarden(gardenView);
}

const postureWeights = [46, 13, 12, 11, 8, 5, 5];
const classRows = [
  ["三年级一班", "86%", "2 人", "36 台"],
  ["四年级二班", "82%", "3 人", "34 台"],
  ["五年级三班", "77%", "5 人", "31 台"],
  ["六年级一班", "73%", "7 人", "27 台"],
];
const riskRows = [
  ["林同学", "五年级三班", "0.32", "连续 3 周黄色"],
  ["赵同学", "六年级一班", "0.35", "右倾占比 28%"],
  ["王同学", "四年级二班", "0.29", "前倾累计偏高"],
  ["陈同学", "三年级一班", "0.27", "前倾持续偏高"],
];
const deviceRows = [
  ["SG-001", "三年级一班", "在线", "v0.9.2"],
  ["SG-014", "四年级二班", "在线", "v0.9.1"],
  ["SG-027", "五年级三班", "同步中", "v0.8.8"],
  ["SG-053", "六年级一班", "离线", "v0.8.8"],
];
const notifications = [
  ["本周坐姿报告已生成", "标准坐姿率 84%，左倾频率较上周下降 6%。"],
  ["班级排名更新", "当前孩子在三年级一班坐姿成长榜排名第 3。"],
  ["月度健康提醒", "建议本月继续关注写作业时的前倾姿态。"],
];

function weightedPosture() {
  const total = postureWeights.reduce((sum, item) => sum + item, 0);
  let roll = Math.random() * total;
  for (let i = 0; i < postureWeights.length; i += 1) {
    roll -= postureWeights[i];
    if (roll <= 0) return postures[i];
  }
  return postures[0];
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function pressureColor(value) {
  const v = clamp(value, 0, 100);
  if (v < 18) return `rgba(64, 96, 118, ${0.28 + v / 120})`;
  if (v < 42) return `rgba(52, 231, 255, ${0.18 + v / 120})`;
  if (v < 68) return `rgba(57, 255, 182, ${0.22 + v / 130})`;
  if (v < 84) return `rgba(255, 209, 102, ${0.28 + v / 140})`;
  return `rgba(255, 77, 125, ${0.34 + v / 150})`;
}

function heatRgb(value) {
  const stops = [
    [0, [32, 57, 88]],
    [24, [39, 174, 213]],
    [48, [64, 222, 170]],
    [68, [240, 224, 91]],
    [84, [255, 139, 71]],
    [100, [255, 63, 105]],
  ];
  const target = clamp(value, 0, 100);
  const endIndex = stops.findIndex(([stop]) => target <= stop);
  const end = stops[endIndex < 1 ? 1 : endIndex];
  const start = stops[Math.max(0, (endIndex < 1 ? 1 : endIndex) - 1)];
  const ratio = (target - start[0]) / (end[0] - start[0] || 1);
  return start[1].map((channel, index) => Math.round(channel + (end[1][index] - channel) * ratio));
}

function buildGrid(selector, count) {
  const grid = $(selector);
  if (!grid) return;
  grid.innerHTML = Array.from({ length: count }, () => '<span class="heat-cell"></span>').join("");
}

function buildSeat3D() {
  const host = $("#seat-3d");
  if (!host || !window.THREE) {
    if (host) host.textContent = "3D 组件加载失败";
    return;
  }

  const THREE = window.THREE;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
  camera.position.set(0, 5.7, -9.6);
  camera.lookAt(0, 1.2, 0.25);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.domElement.setAttribute("aria-label", "可拖动查看的三维座椅，含靠背测距传感器与坐垫五点压力热力图");
  renderer.domElement.setAttribute("role", "img");
  host.appendChild(renderer.domElement);

  const group = new THREE.Group();
  group.rotation.set(-0.04, 0.28, 0);
  scene.add(group);

  const bodyMaterial = new THREE.MeshPhysicalMaterial({
    color: 0x12394a,
    roughness: 0.48,
    metalness: 0.08,
    clearcoat: 0.45,
  });
  const base = new THREE.Mesh(
    new THREE.BoxGeometry(5.5, 0.62, 4.25, 6, 2, 6),
    bodyMaterial
  );
  base.castShadow = true;
  base.receiveShadow = true;
  group.add(base);

  const backrestGroup = new THREE.Group();
  backrestGroup.position.set(0, 2.22, 1.94);
  backrestGroup.rotation.x = 0.1;
  group.add(backrestGroup);
  const backrestWidthScale = 1.25;
  const backrestHeightScale = 1.18;

  const backrestShape = new THREE.Shape();
  backrestShape.moveTo(-2.02, -1.48);
  backrestShape.bezierCurveTo(-2.3, -1.08, -2.34, 0.42, -1.76, 1.3);
  backrestShape.bezierCurveTo(-1.28, 1.64, -0.62, 1.58, 0, 1.4);
  backrestShape.bezierCurveTo(0.62, 1.58, 1.28, 1.64, 1.76, 1.3);
  backrestShape.bezierCurveTo(2.34, 0.42, 2.3, -1.08, 2.02, -1.48);
  backrestShape.bezierCurveTo(1.34, -1.34, 0.72, -1.12, 0, -1.12);
  backrestShape.bezierCurveTo(-0.72, -1.12, -1.34, -1.34, -2.02, -1.48);
  backrestShape.closePath();

  const backrestGeometry = new THREE.ExtrudeGeometry(backrestShape, {
    depth: 0.46,
    bevelEnabled: true,
    bevelSegments: 5,
    bevelSize: 0.1,
    bevelThickness: 0.1,
    curveSegments: 24,
    steps: 1,
  });
  backrestGeometry.center();
  backrestGeometry.computeBoundingBox();
  const backrestFrontZ = backrestGeometry.boundingBox.min.z;
  const backrest = new THREE.Mesh(
    backrestGeometry,
    new THREE.MeshPhysicalMaterial({
      color: 0x164756,
      roughness: 0.5,
      metalness: 0.04,
      clearcoat: 0.42,
    })
  );
  backrest.scale.set(backrestWidthScale, backrestHeightScale, 1);
  backrest.castShadow = true;
  backrest.receiveShadow = true;
  backrestGroup.add(backrest);

  const backrestPanel = new THREE.Mesh(
    new THREE.ShapeGeometry(backrestShape, 24),
    new THREE.MeshBasicMaterial({
      color: 0x173d49,
      side: THREE.DoubleSide,
    })
  );
  backrestPanel.scale.set(0.91 * backrestWidthScale, 0.88 * backrestHeightScale, 1);
  backrestPanel.position.set(0, 0.02, backrestFrontZ - 0.006);
  backrestPanel.receiveShadow = true;
  backrestGroup.add(backrestPanel);

  const backrestOutline = new THREE.LineSegments(
    new THREE.EdgesGeometry(backrest.geometry, 28),
    new THREE.LineBasicMaterial({ color: 0x63bdca, transparent: true, opacity: 0.58 })
  );
  backrestOutline.scale.set(backrestWidthScale, backrestHeightScale, 1);
  backrestGroup.add(backrestOutline);

  const sensorHousing = new THREE.Mesh(
    new THREE.BoxGeometry(0.58, 0.32, 0.18),
    new THREE.MeshPhysicalMaterial({
      color: 0x061a23,
      emissive: 0x0b3945,
      emissiveIntensity: 0.4,
      roughness: 0.3,
      metalness: 0.24,
      clearcoat: 0.7,
    })
  );
  sensorHousing.position.set(0, 1.36, backrestFrontZ - 0.1);
  sensorHousing.castShadow = true;
  backrestGroup.add(sensorHousing);

  const sensorLens = new THREE.Mesh(
    new THREE.SphereGeometry(0.105, 24, 18),
    new THREE.MeshBasicMaterial({ color: 0x42e3ef })
  );
  sensorLens.scale.z = 0.34;
  sensorLens.position.set(0, 1.36, backrestFrontZ - 0.21);
  backrestGroup.add(sensorLens);

  const sensorHalo = new THREE.Mesh(
    new THREE.RingGeometry(0.15, 0.19, 32),
    new THREE.MeshBasicMaterial({
      color: 0x6cf1f6,
      transparent: true,
      opacity: 0.42,
      side: THREE.DoubleSide,
    })
  );
  sensorHalo.position.set(0, 1.36, backrestFrontZ - 0.21);
  backrestGroup.add(sensorHalo);

  const textureCanvas = document.createElement("canvas");
  textureCanvas.width = 256;
  textureCanvas.height = 196;
  const texture = new THREE.CanvasTexture(textureCanvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.encoding = THREE.sRGBEncoding;

  const heatmap = new THREE.Mesh(
    new THREE.PlaneGeometry(5.32, 4.07),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, opacity: 0.96 })
  );
  heatmap.rotation.x = -Math.PI / 2;
  heatmap.position.y = 0.321;
  group.add(heatmap);

  const markers = pressureSensors.map((sensor) => {
    const marker = new THREE.Mesh(
      new THREE.RingGeometry(0.075, 0.125, 32),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.92, side: THREE.DoubleSide })
    );
    marker.rotation.x = -Math.PI / 2;
    marker.position.set((sensor.x - 0.5) * 5.1, 0.34, (sensor.y - 0.5) * 3.85);
    group.add(marker);
    return marker;
  });

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(10, 9),
    new THREE.ShadowMaterial({ color: 0x000000, opacity: 0.3 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.72;
  floor.receiveShadow = true;
  scene.add(floor);

  scene.add(new THREE.HemisphereLight(0xc9f8ff, 0x031018, 1.45));
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.2);
  keyLight.position.set(-3, 8, -5);
  keyLight.castShadow = true;
  scene.add(keyLight);
  const rimLight = new THREE.PointLight(0x34e7ff, 1.2, 16);
  rimLight.position.set(4, 3, 4);
  scene.add(rimLight);

  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  renderer.domElement.addEventListener("pointerdown", (event) => {
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    renderer.domElement.setPointerCapture(event.pointerId);
  });
  renderer.domElement.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    group.rotation.y += (event.clientX - lastX) * 0.008;
    group.rotation.x = clamp(group.rotation.x + (event.clientY - lastY) * 0.005, -0.38, 0.32);
    lastX = event.clientX;
    lastY = event.clientY;
  });
  renderer.domElement.addEventListener("pointerup", () => { dragging = false; });
  renderer.domElement.addEventListener("pointercancel", () => { dragging = false; });

  const resize = () => {
    const rect = host.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(host);
  resize();

  const animate = () => {
    renderer.render(scene, camera);
    requestAnimationFrame(animate);
  };
  animate();
  seatScene = { textureCanvas, texture, markers };
}

function generateSeatPressure(posture) {
  const profiles = [
    { left: 520, right: 510, front: 430, back: 620, center: 760 },
    { left: 850, right: 260, front: 430, back: 610, center: 700 },
    { left: 260, right: 850, front: 430, back: 610, center: 700 },
    { left: 520, right: 510, front: 850, back: 250, center: 650 },
    { left: 520, right: 510, front: 250, back: 850, center: 650 },
    { left: 880, right: 310, front: 560, back: 420, center: 690 },
    { left: 790, right: 350, front: 380, back: 720, center: 640 },
    { left: 70, right: 60, front: 45, back: 80, center: 95 },
  ];
  const profile = profiles[posture.id] || profiles[0];
  return Object.fromEntries(
    pressureSensors.map(({ key }) => [key, clamp(Math.round(profile[key] + (Math.random() - 0.5) * 34), 0, 1000)])
  );
}

function generateBackPressure(posture) {
  return Array.from({ length: 32 }, (_, index) => {
    const row = Math.floor(index / 4);
    const col = index % 4;
    let value = 18 + Math.random() * 20;
    if (row >= 1 && row <= 6) value += 18;
    if (posture.id === 1 && col <= 1) value += 22;
    if (posture.id === 2 && col >= 2) value += 22;
    if (posture.id === 3) value *= 0.32;
    if (posture.id === 4 && row >= 5) value += 34;
    if (posture.id === 6 && col <= 1) value += 30;
    if (posture.id === 7) value *= 0.18;
    return clamp(value, 1, 100);
  });
}

function paintHeatmap(selector, values) {
  $$(selector + " .heat-cell").forEach((cell, index) => {
    const value = values[index] || 0;
    cell.style.background = pressureColor(value);
    cell.title = `压力值 ${Math.round(value)}`;
    cell.classList.toggle("hot", value > 78);
  });
}

function paintSeat3D(values, rawValues = null, protocolVersion = null) {
  if (!seatScene) return;
  const context = seatScene.textureCanvas.getContext("2d");
  const width = seatScene.textureCanvas.width;
  const height = seatScene.textureCanvas.height;
  const image = context.createImageData(width, height);
  const spread = 0.26;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const nx = x / (width - 1);
      const ny = y / (height - 1);
      let weighted = 0;
      let totalWeight = 0;
      pressureSensors.forEach((sensor) => {
        const distance = (nx - sensor.x) ** 2 + (ny - sensor.y) ** 2;
        const weight = Math.exp(-distance / (2 * spread * spread));
        weighted += (values[sensor.key] / 10) * weight;
        totalWeight += weight;
      });
      const [red, green, blue] = heatRgb(weighted / totalWeight);
      const offset = (y * width + x) * 4;
      image.data[offset] = red;
      image.data[offset + 1] = green;
      image.data[offset + 2] = blue;
      image.data[offset + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  seatScene.texture.needsUpdate = true;

  seatScene.markers.forEach((marker, index) => {
    const value = values[pressureSensors[index].key] / 10;
    const [red, green, blue] = heatRgb(value);
    marker.material.color.setRGB(red / 255, green / 255, blue / 255);
    marker.scale.setScalar(0.9 + value / 220);
  });

  const readings = $("#seat-sensor-values");
  if (readings) {
    readings.innerHTML = pressureSensors.map((sensor) => (
      `<span><b>${sensor.label}</b><strong>${values[sensor.key]}</strong><em>${rawValues ? `ADC ${rawValues[sensor.key]}` : "ADC --"}</em></span>`
    )).join("");
  }
  const source = $("#seat-source");
  if (source) {
    source.textContent = protocolVersion === 2
      ? "V2 · 归一化压力 / 12-bit ADC 原始值"
      : "V1 历史记录 · 无 ADC 原始值";
  }
}

function metric(label, value, note, valueClass = "") {
  return `<article class="metric-card"><span>${label}</span><strong class="${valueClass}">${value}</strong><small>${note}</small></article>`;
}

function renderDashboard() {
  if (!state.user) return;
  const role = state.user.role;
  if (role === "admin") {
    return;
  }

  if (!$("#workflow-title")) return;

  const posture = state.posture || postures[0];
  const telemetry = state.latestTelemetry;
  $("#dashboard-eyebrow").textContent = "Child Overview";
  $("#dashboard-title").textContent = "孩子今日坐姿概览";
  $("#dashboard-desc").textContent = "家长可查看绑定设备的实时状态、报告和游戏化矫正成果。";
  $("#dashboard-metrics").innerHTML = [
    metric("设备状态", telemetry ? "在线" : "等待数据", state.currentDeviceId || "未绑定设备"),
    metric("连续就坐", telemetry ? formatDuration(telemetry.sittingSeconds) : "--", "当前会话"),
    metric("风险等级", posture.risk, "基于压力不对称指数", posture.riskClass),
    metric("提醒次数", `${telemetry?.reminderCount ?? 0} 次`, "设备会话累计"),
  ].join("");
  $("#workflow-title").textContent = "家庭矫正链路";
  $("#workflow-desc").textContent = "实时监测、轻提醒、周报和游戏激励形成习惯闭环。";
  $("#workflow-pipeline").innerHTML = [
    ["采集", "五点 FSR / 靠背测距"],
    ["识别", "板端 LightGBM / 规则模型"],
    ["反馈", "定向振动 / 压力热力图"],
    ["强化", "周报 / 种树成长值"],
  ].map(([a, b]) => `<div><b>${a}</b><span>${b}</span></div>`).join("");
  $("#signal-text").textContent = posture.name;
  $("#signal-desc").textContent = posture.desc;
}

function renderParentLiveMetrics(posture, telemetry = state.latestTelemetry) {
  const target = $("#parent-live-metrics");
  if (!target) return;
  const batteryText = telemetry?.batteryLevel == null ? "电量未接入" : `电量 ${telemetry.batteryLevel}%`;
  const backrestText = telemetry?.backrest?.online && telemetry.backrest.valid && telemetry.backrest.distanceMm != null
    ? `靠背距离 ${(telemetry.backrest.distanceMm / 10).toFixed(1)} cm`
    : "靠背距离暂不可用";
  target.innerHTML = [
    metric("设备状态", telemetry ? "在线" : "等待数据", `${state.currentDeviceId || "未绑定设备"} · ${telemetry ? batteryText : state.backendError || "后端同步"}`),
    metric("当前坐姿", posture.name, posture.desc, posture.riskClass),
    metric("靠背测距", telemetry?.backrest?.online && telemetry.backrest.valid && telemetry.backrest.distanceMm != null ? `${(telemetry.backrest.distanceMm / 10).toFixed(1)} cm` : "--", backrestText),
    metric("提醒次数", `${telemetry?.reminderCount ?? 0} 次`, "设备会话累计"),
  ].join("");
}

function updateMetrics(posture, asymmetry, telemetry = state.latestTelemetry) {
  const optional = (selector, value) => {
    const el = $(selector);
    if (el) el.textContent = value;
  };
  optional("#posture-id", posture.id);
  optional("#posture-name", posture.name);
  optional("#posture-desc", posture.desc);
  optional("#asymmetry-index", asymmetry.toFixed(2));
  optional("#duration", telemetry ? formatDuration(telemetry.durationSeconds) : "--");
  optional("#vibration", telemetry?.vibrationActive ? `振动中${telemetry.vibrationPosition ? ` · ${telemetry.vibrationPosition}` : ""}` : telemetry?.warningActive ? "待提醒" : "未触发");
  optional("#seat-pressure-label", posture.seatLabel);
  optional("#back-pressure-label", posture.backLabel);
  optional("#live-time", new Date().toLocaleTimeString("zh-CN", { hour12: false }));
  renderParentLiveMetrics(posture, telemetry);

  const ring = $("#posture-ring");
  if (ring) {
    ring.style.borderColor = posture.riskClass === "risk-yellow" ? "rgba(255, 209, 102, 0.38)" : "rgba(52, 231, 255, 0.24)";
    if (posture.vibration === "已触发") ring.style.borderColor = "rgba(255, 77, 125, 0.42)";
  }
  renderDashboard();
}

function updateTrend() {
  const chart = $("#trend-chart");
  if (!chart) return;
  if (!state.latestTelemetry) return;
  if (state.trend.length >= 24) state.trend.shift();
  state.trend.push({
    label: new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
    value: state.latestTelemetry.postureCode === "normal" ? 100 : 0,
  });
  chart.innerHTML = state.trend
    .map((point) => {
      const level = point.value < 55 ? "danger" : point.value < 72 ? "warning" : "";
      return `<div class="bar ${level}" style="height:${point.value}%"><span>${Math.round(point.value)}%</span></div>`;
    })
    .join("");
}

async function loadHistoryTrend() {
  if (!state.currentStudentId) return;
  try {
    const result = await SpineGuardApi.studentHistory(state.currentStudentId, {limit: 24});
    state.trend = (result.items || []).map(mapTelemetry).filter((item) => item.postureCode !== "empty").map((item) => ({
      label: new Date(item.recordedAt).toLocaleTimeString("zh-CN", {hour: "2-digit", minute: "2-digit"}),
      value: item.postureCode === "normal" ? 100 : 0,
    }));
    updateTrend();
  } catch (error) {
    console.warn("历史趋势同步失败", error);
  }
}

async function fetchLatestForCurrentContext() {
  return state.currentStudentId
    ? SpineGuardApi.studentLatest(state.currentStudentId)
    : SpineGuardApi.deviceLatest(state.currentDeviceId);
}

async function updateLiveData() {
  if (!state.user || !state.token) return;
  try {
    const response = await fetchLatestForCurrentContext();
    const telemetry = mapTelemetry(response.data);
    if (!telemetry) {
      state.backendError = "暂无遥测数据";
      renderParentLiveMetrics(state.posture || postures[0], null);
      return;
    }
    applyLiveTelemetry(telemetry);
    livePollDelay = 2200;
  } catch (error) {
    let finalError = error;
    if (error?.status === 403 && state.user?.role === "parent") {
      const deniedStudentId = state.currentStudentId;
      try {
        const resolvedStudentId = await resolveCurrentStudent();
        if (resolvedStudentId && resolvedStudentId !== deniedStudentId) {
          const response = await fetchLatestForCurrentContext();
          const telemetry = mapTelemetry(response.data);
          if (telemetry) {
            applyLiveTelemetry(telemetry);
            livePollDelay = 2200;
            connectStudentSocket();
            connectGameSocket();
            return;
          }
        }
      } catch (contextError) {
        finalError = contextError;
      }
    }
    state.backendError = finalError.message;
    renderParentLiveMetrics(state.posture || postures[0], null);
    livePollDelay = Math.min(30000, livePollDelay * 2);
  }
}

function applyLiveTelemetry(telemetry) {
  state.backendError = "";
  if (state.latestTelemetry?.deviceSessionId === telemetry.deviceSessionId
    && state.latestTelemetry?.sequence === telemetry.sequence) return;
  state.latestTelemetry = telemetry;
  state.posture = telemetry.posture;
  state.latestSeat = telemetry.pressure;
  paintSeat3D(telemetry.pressure, telemetry.rawPressure, telemetry.protocolVersion);
  updateMetrics(telemetry.posture, telemetry.asymmetry, telemetry);
  updateTrend();
  if (SpineGuardGardenService.mode === "mock") {
    SpineGuardGardenService.recordTelemetry(telemetry).then((garden) => {
      applyGardenViewModel(garden);
      gardenTreeController?.setState(getTreeVisualState());
      if ($("#game")?.classList.contains("active") && gardenView === "home" && Date.now() - Number(applyLiveTelemetry.lastGardenRender || 0) > 10000) {
        applyLiveTelemetry.lastGardenRender = Date.now(); renderGarden("home");
      }
    }).catch((error) => console.warn("Mock 乐园遥测结算失败", error));
  }
  if (focusSession) updateFocusDisplay();
}

function scheduleLivePolling() {
  clearTimeout(livePollTimer);
  livePollTimer = setTimeout(async () => {
    await updateLiveData();
    scheduleLivePolling();
  }, liveSocketConnected ? 10000 : livePollDelay);
}

function connectStudentSocket() {
  if (SpineGuardApi.mode !== "api" || !state.currentStudentId || !state.token || typeof WebSocket === "undefined") return;
  clearTimeout(liveSocketReconnectTimer);
  if (liveSocket) liveSocket.close();
  const wsBase = SpineGuardApi.apiBase.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  const socket = new WebSocket(`${wsBase}/ws/students/${encodeURIComponent(state.currentStudentId)}?token=${encodeURIComponent(state.token)}`);
  liveSocket = socket;
  socket.addEventListener("open", () => { liveSocketConnected = true; livePollDelay = 2200; });
  socket.addEventListener("message", (event) => {
    try { applyLiveTelemetry(mapTelemetry(JSON.parse(event.data))); }
    catch (error) { state.backendError = `实时数据结构错误：${error.message}`; }
  });
  socket.addEventListener("close", () => {
    if (liveSocket !== socket) return;
    liveSocketConnected = false;
    liveSocket = null;
    if (state.token && state.currentStudentId) {
      liveSocketReconnectTimer = setTimeout(connectStudentSocket, Math.min(10000, Math.max(1500, livePollDelay)));
    }
  });
  socket.addEventListener("error", () => { liveSocketConnected = false; socket.close(); });
}

function connectGameSocket() {
  if (SpineGuardGardenService.mode !== "api" || !state.currentStudentId || !state.token || typeof WebSocket === "undefined") return;
  if (gameSocket) gameSocket.close();
  const wsBase = SpineGuardApi.apiBase.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  gameSocket = new WebSocket(`${wsBase}/ws/students/${encodeURIComponent(state.currentStudentId)}/game?token=${encodeURIComponent(state.token)}`);
  gameSocket.addEventListener("message", async (event) => {
    let payload = null;
    try { payload = JSON.parse(event.data); } catch (_) { /* 后续仍刷新乐园事实源。 */ }
    if (payload?.event === "report.generated") {
      await loadNotifications();
      if (state.user?.role === "parent") await renderReport();
    }
    clearTimeout(connectGameSocket.refreshTimer);
    connectGameSocket.refreshTimer = setTimeout(async () => {
      await gardenApi.load();
      if ($("#game")?.classList.contains("active")) renderGarden(gardenView);
    }, 120);
  });
  gameSocket.addEventListener("close", () => {
    gameSocket = null;
    clearTimeout(connectGameSocket.retryTimer);
    if (state.token && state.currentStudentId) connectGameSocket.retryTimer = setTimeout(connectGameSocket, 3000);
  });
  gameSocket.addEventListener("error", () => gameSocket?.close());
}

function getGardenStage() {
  return gardenStages.findLast((stage) => gardenState.growth >= stage.min) || gardenStages[0];
}

function getTreeVisualState() {
  const parts = String(gardenState.instantTreeState || "").split(":");
  const instantState = parts[0];
  const statePosture = { resting: "empty", unknown: "unknown", normal: "normal" }[instantState];
  const known = Object.prototype.hasOwnProperty.call(postureCodeToId, instantState);
  const postureCode = statePosture || (known ? instantState : (state.latestTelemetry?.postureCode || "unknown"));
  return {
    postureCode,
    postureId: postureCodeToId[postureCode] ?? 5,
    severity: instantState === "abnormal_severe" || parts.includes("severe") ? 2
      : instantState === "abnormal_reminded" || parts.includes("warning") ? 1
        : instantState === "abnormal_mild" || parts.includes("mild") ? 0.5 : 0,
    offline: instantState === "offline",
    recovery: Boolean(gardenState.recoveryNeeded || parts.includes("recovery")),
  };
}

function getPlanTotals() {
  const plan = gardenState.plan;
  return {
    actions: Object.values(plan).reduce((sum, count) => sum + count, 0),
    sunshine: plan.sunbathe * 3 + plan.recover_tree * 2,
    water: plan.water * 5,
    nutrient: plan.fertilize * 3 + plan.recover_tree * 3,
    growth: plan.sunbathe * 10 + plan.water * 15 + plan.fertilize * 30,
  };
}

function formatDuration(seconds) {
  const safe = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

function createGardenTree(host, compact = false) {
  if (!host || !window.THREE) return null;
  host.innerHTML = "";
  const THREE = window.THREE;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(33, 1, 0.1, 50);
  camera.position.set(0, compact ? 3.65 : 3.8, compact ? 11.8 : 10.7);
  camera.lookAt(0, compact ? 1.95 : 1.85, 0);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.shadowMap.enabled = true;
  renderer.domElement.setAttribute("role", "img");
  renderer.domElement.setAttribute("aria-label", "随坐姿状态变化的成长树");
  host.appendChild(renderer.domElement);

  const tree = new THREE.Group();
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.22, 0.34, 2.5, 18),
    new THREE.MeshStandardMaterial({ color: 0x8b6848, roughness: 0.82 })
  );
  trunk.position.y = 1.3;
  trunk.castShadow = true;
  tree.add(trunk);
  const crownMaterial = new THREE.MeshStandardMaterial({ color: 0x4adf8f, roughness: 0.58 });
  const crownPositions = [[0, 3.25, 0, 1.25], [-0.9, 2.9, 0.05, 0.88], [0.92, 2.95, 0, 0.92], [-0.42, 3.82, -0.05, 0.82], [0.52, 3.72, 0.08, 0.78]];
  const crowns = crownPositions.map(([x, y, z, scale]) => {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(scale, 24, 18), crownMaterial);
    mesh.position.set(x, y, z);
    mesh.scale.y = 0.82;
    mesh.castShadow = true;
    tree.add(mesh);
    return mesh;
  });
  const stageIndex = Math.max(0, gardenStages.indexOf(getGardenStage()));
  const stageDecorations = [];
  const flowerMaterial = new THREE.MeshStandardMaterial({ color: 0xff5f9d, emissive: 0x3d071d, emissiveIntensity: 0.18, roughness: 0.58 });
  const flowerCenterMaterial = new THREE.MeshStandardMaterial({ color: 0xffc83d, emissive: 0x3c2200, emissiveIntensity: 0.16, roughness: 0.52 });
  const flowerGeometry = new THREE.SphereGeometry(0.115, 12, 9);
  const flowerCenterGeometry = new THREE.SphereGeometry(0.09, 12, 9);
  const addFlower = (x, y, z, scale = 1, rotation = 0) => {
    const flower = new THREE.Group();
    flower.position.set(x, y, z);
    flower.rotation.z = rotation;
    flower.scale.setScalar(scale);
    for (let petalIndex = 0; petalIndex < 5; petalIndex += 1) {
      const angle = petalIndex / 5 * Math.PI * 2;
      const petal = new THREE.Mesh(flowerGeometry, flowerMaterial);
      petal.position.set(Math.cos(angle) * 0.15, Math.sin(angle) * 0.15, 0);
      petal.scale.set(1.3, 0.78, 0.52);
      petal.rotation.z = angle;
      petal.castShadow = true;
      flower.add(petal);
    }
    const center = new THREE.Mesh(flowerCenterGeometry, flowerCenterMaterial);
    center.position.z = 0.055;
    center.castShadow = true;
    flower.add(center);
    tree.add(flower);
    stageDecorations.push(flower);
  };
  const fruitGeometry = new THREE.SphereGeometry(0.2, 18, 14);
  const stemGeometry = new THREE.CylinderGeometry(0.018, 0.022, 0.18, 8);
  const fruitColors = [0xf04450, 0xff8128, 0xf4b21a];
  const addFruit = (x, y, z, scale = 1, colorIndex = 0) => {
    const fruit = new THREE.Group();
    fruit.position.set(x, y, z);
    fruit.scale.setScalar(scale);
    const body = new THREE.Mesh(
      fruitGeometry,
      new THREE.MeshStandardMaterial({
        color: fruitColors[colorIndex % fruitColors.length],
        emissive: [0x360307, 0x351100, 0x302000][colorIndex % fruitColors.length],
        emissiveIntensity: 0.13,
        roughness: 0.42,
      })
    );
    body.scale.set(0.9, 1.08, 0.9);
    body.castShadow = true;
    fruit.add(body);
    const stem = new THREE.Mesh(stemGeometry, new THREE.MeshStandardMaterial({ color: 0x6a4b2d, roughness: 0.86 }));
    stem.position.y = 0.26;
    stem.rotation.z = 0.14;
    fruit.add(stem);
    tree.add(fruit);
    stageDecorations.push(fruit);
  };
  if (stageIndex === 0) {
    trunk.visible = false;
    crowns.forEach((mesh) => { mesh.visible = false; });
    const seed = new THREE.Mesh(new THREE.SphereGeometry(0.48, 20, 14), new THREE.MeshStandardMaterial({ color: 0x875d3d, roughness: 0.9 }));
    seed.scale.set(1.25, 0.72, 0.85); seed.rotation.z = -0.25; seed.position.y = 0.42; tree.add(seed); stageDecorations.push(seed);
  } else if (stageIndex === 1) {
    trunk.scale.set(0.26, 0.42, 0.26); trunk.position.y = 0.55;
    crowns.forEach((mesh, index) => { mesh.visible = index < 2; mesh.scale.set(0.34, 0.18, 0.22); mesh.position.set(index ? 0.34 : -0.34, 1.1, 0); mesh.rotation.z = index ? -0.5 : 0.5; });
  } else if (stageIndex === 2) {
    trunk.scale.set(0.62, 0.72, 0.62); trunk.position.y = 0.92;
    crowns.forEach((mesh, index) => { mesh.visible = index < 3; mesh.scale.multiplyScalar(0.62); mesh.position.y *= 0.73; });
  } else if (stageIndex === 3) {
    trunk.scale.set(1.12, 1.12, 1.12);
    crowns.forEach((mesh) => mesh.scale.multiplyScalar(1.1));
  } else if (stageIndex === 4) {
    trunk.scale.set(1.16, 1.16, 1.16);
    crowns.forEach((mesh) => mesh.scale.multiplyScalar(1.12));
    [
      [-1.12, 3.14, 1.34, 1.02, -0.18], [-0.72, 3.62, 1.38, 1.12, 0.12],
      [-0.24, 3.02, 1.48, 1.18, -0.08], [0.18, 3.82, 1.38, 1.05, 0.2],
      [0.52, 3.28, 1.48, 1.15, -0.15], [1.02, 3.1, 1.34, 1.04, 0.08],
      [-0.52, 2.68, 1.34, 0.98, 0.16], [0.42, 2.68, 1.38, 1, -0.12],
      [0.76, 3.72, 1.28, 0.94, 0.14], [-0.12, 4.12, 1.2, 0.92, -0.2],
    ].forEach((flower) => addFlower(...flower));
  } else if (stageIndex === 5) {
    trunk.scale.set(1.18, 1.18, 1.18);
    crowns.forEach((mesh, index) => {
      mesh.scale.multiplyScalar(1.14);
      mesh.material = crownMaterial.clone();
      mesh.material.color.setHex([0x36c978, 0x65dc78, 0x28b96e, 0x86df69, 0x42cf8c][index]);
    });
    [
      [-1.04, 3.08, 0.86, 1.02, 0], [-0.68, 3.62, 0.94, 0.92, 1],
      [-0.28, 2.82, 1.18, 1.08, 2], [0.02, 3.62, 1.18, 1.15, 0],
      [0.46, 3.08, 1.22, 1.04, 1], [0.92, 3.42, 0.9, 0.96, 2],
      [0.78, 2.82, 0.86, 0.9, 0], [-0.12, 4.02, 0.66, 0.88, 1],
    ].forEach((fruit) => addFruit(...fruit));
    addFlower(-0.48, 3.92, 1.28, 0.72, 0.16);
    addFlower(1.04, 3.0, 1.22, 0.68, -0.12);
  }
  scene.add(tree);

  const ground = new THREE.Mesh(
    new THREE.CylinderGeometry(2.8, 3.15, 0.25, 48),
    new THREE.MeshStandardMaterial({ color: 0x164f44, roughness: 0.95 })
  );
  ground.position.y = -0.08;
  ground.receiveShadow = true;
  scene.add(ground);
  scene.add(new THREE.HemisphereLight(0xd8fff2, 0x06221c, 1.55));
  const sunlight = new THREE.DirectionalLight(0xfff1b8, 1.8);
  sunlight.position.set(-4, 7, 5);
  sunlight.castShadow = true;
  scene.add(sunlight);
  const fill = new THREE.PointLight(0x39ffb6, 0.75, 15);
  fill.position.set(4, 3, 3);
  scene.add(fill);

  let postureId = 0;
  let severity = 0;
  let offline = false;
  let recovery = false;
  let active = true;
  const resize = () => {
    const rect = host.getBoundingClientRect();
    renderer.setSize(Math.max(1, rect.width), Math.max(1, rect.height), false);
    camera.aspect = Math.max(1, rect.width) / Math.max(1, rect.height);
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  resize();
  const animate = (time) => {
    if (!active) return;
    const sway = Math.sin(time * 0.0012) * 0.022;
    const depth = severity >= 2 ? 1.75 : severity >= 1 ? 1.4 : severity > 0 ? 1.15 : 1;
    const postureLean = (postureId === 1 ? 0.18 : postureId === 2 ? -0.18 : postureId === 3 ? 0.08 : postureId === 4 ? -0.06 : 0) * depth;
    tree.rotation.z += ((postureLean + (offline ? 0 : sway)) - tree.rotation.z) * 0.035;
    crowns.forEach((crown, index) => { crown.position.y += Math.sin(time * 0.0015 + index) * 0.0008; });
    renderer.render(scene, camera);
    requestAnimationFrame(animate);
  };
  requestAnimationFrame(animate);
  return {
    setPosture(id) {
      postureId = id;
      host.dataset.posture = String(id);
      crownMaterial.color.setHex(id === 3 ? 0x79a97c : id === 5 || id === 6 ? 0x6c8f88 : 0x4adf8f);
      tree.scale.y = id === 3 ? 0.88 : id === 5 || id === 6 ? 0.94 : 1;
    },
    setState(next) {
      postureId = next.postureId;
      severity = next.severity;
      offline = next.offline;
      recovery = next.recovery;
      host.dataset.treeState = `${next.postureCode}:${severity}:${offline}:${recovery}`;
      const color = offline ? 0x6f817b : severity >= 2 ? 0x799173 : recovery ? 0x8ca982 : postureId === 3 ? 0x79a97c : postureId === 5 || postureId === 6 ? 0x6c8f88 : 0x4adf8f;
      crownMaterial.color.setHex(color);
      tree.scale.y = severity >= 2 ? 0.78 : recovery ? 0.88 : postureId === 3 ? 0.88 : postureId === 5 || postureId === 6 ? 0.94 : 1;
    },
    destroy() {
      active = false;
      observer.disconnect();
      renderer.dispose();
    },
  };
}

function gardenProgressMarkup(value, max, label) {
  const percent = clamp(Math.round(value / max * 100), 0, 100);
  return `<div class="garden-progress" aria-label="${label} ${value}/${max}"><span style="width:${percent}%"></span></div>`;
}

function renderGarden(view = gardenView) {
  gardenView = view;
  const target = $("#garden-view");
  if (!target) return;
  target.classList.toggle("garden-mock-home", view === "home" && SpineGuardGardenService.mode === "mock");
  if (gardenTreeController) gardenTreeController.destroy();
  gardenTreeController = null;
  $$("[data-garden-view]").forEach((button) => button.classList.toggle("active", button.dataset.gardenView === view));
  if (view === "home") renderGardenHome(target);
  if (view === "focus") renderGardenFocus(target);
  if (view === "archive") renderGardenArchive(target);
  if (view === "collection") renderGardenCollection(target);
}

function renderGardenHome(target) {
  const stage = getGardenStage();
  const isFinal = stage.name === "结果期";
  const next = gardenStages[gardenStages.indexOf(stage) + 1];
  const plan = getPlanTotals();
  const statusLabels = { locked: "未达成", claimable: "可领取", claimed: "已领取" };
  const operationDisabled = SpineGuardGardenService.mode === "api" && Boolean(gardenLoadError);
  const canRecover = gardenState.recoveryNeeded && String(gardenState.instantTreeState || "").startsWith("normal");
  target.innerHTML = `
    ${gardenLoadError ? `<div class="garden-api-notice"><strong>乐园后端尚未就绪</strong><span>${gardenLoadError}</span></div>` : ""}
    <div class="treehouse-grid">
      <section class="garden-scene-band">
        <div id="garden-tree-canvas" class="garden-tree-canvas"></div>
        <div class="tree-weather"><span>晴朗 · 微风</span><strong>${(state.posture || postures[0]).name}</strong></div>
      </section>
      <section class="garden-summary">
        <p class="eyebrow">当前阶段</p><h2>${stage.name}</h2>
        <div class="growth-number"><strong>${gardenState.growth}</strong><span>${isFinal ? "本轮累计成长值" : `/ ${stage.next}`}</span></div>
        ${isFinal ? `<p>已结出 ${gardenState.fruits} 枚成长果实</p>` : `${gardenProgressMarkup(gardenState.growth - stage.min, stage.next - stage.min, "阶段成长进度")}<p>距离${next.name}还差 ${stage.next - gardenState.growth} 点</p>`}
        <p class="garden-rule-version">规则 ${gardenState.ruleVersion || "garden-v1"} · ${SpineGuardGardenService.mode === "mock" ? "Mock 演示数据" : "后端确认数据"}</p>
      </section>
    </div>
    <div class="garden-info-grid">
      <section class="garden-block posture-brief"><div><span>当前坐姿</span><strong>${(state.posture || postures[0]).name}</strong></div><p>连续正确 ${gardenState.continuousCorrectMinutes} 分钟 · 今日累计 ${gardenState.dailyCorrectMinutes} 分钟 · 提醒 ${gardenState.reminderCount} 次 · 30 分钟提醒率 ${(gardenState.reminderRate30m || 0).toFixed(1)}</p></section>
      <section class="garden-block resource-brief"><div class="resource-counts"><span>阳光 <b>${gardenState.resources.sunshine}</b></span><span>水滴 <b>${gardenState.resources.water}</b></span><span>营养 <b>${gardenState.resources.nutrient}</b></span></div><p>最多可晒太阳 ${Math.floor(gardenState.resources.sunshine / 3)} 次、浇水 ${Math.floor(gardenState.resources.water / 5)} 次、施肥 ${Math.floor(gardenState.resources.nutrient / 3)} 次</p></section>
    </div>
    <section class="garden-section">
      <div class="garden-section-head"><div><h2>今日任务</h2><p>达成和领取状态均由服务端状态决定</p></div><span>${new Date().toLocaleDateString("zh-CN")}</span></div>
      <div class="garden-task-list">${gardenState.tasks.map((task) => `<div class="garden-task"><span class="task-state ${task.status}">${statusLabels[task.status] || task.status}</span><div><strong>${task.name}</strong>${gardenProgressMarkup(Math.min(task.progress, task.target), task.target, task.name)}<small>${task.progress}/${task.target}${task.unit} · ${task.reward}</small></div><button class="ghost small" data-garden-action="claim-task" data-task-id="${task.id}" type="button" ${task.status === "claimable" && !operationDisabled ? "" : "disabled"}>${task.status === "claimed" ? "已领取" : "领取"}</button></div>`).join("")}</div>
    </section>
    <section class="garden-section planner-section">
      <div class="garden-section-head"><div><h2>资源规划台</h2><p>每次操作原子提交；成功后以完整余额刷新</p></div><span>${SpineGuardGardenService.mode.toUpperCase()}</span></div>
      <div class="planner-table">${[
        ["sunbathe", "晒太阳", "阳光 3", "成长 +10"], ["water", "浇水", "水滴 5", "成长 +15"], ["fertilize", "施肥", "营养 3", "成长 +30"], ["recover_tree", "恢复小树", "阳光 2 + 营养 3", "只清除恢复残留，不增加成长"],
      ].map(([key, name, cost, gain]) => { const disabled = key === "recover_tree" && !canRecover; return `<div class="planner-row"><strong>${name}</strong><span>${cost}</span><span>${gain}</span><div class="stepper"><button data-plan-action="${key}" data-plan-delta="-1" type="button" aria-label="减少${name}次数" ${disabled ? "disabled" : ""}>−</button><b>${gardenState.plan[key]}</b><button data-plan-action="${key}" data-plan-delta="1" type="button" aria-label="增加${name}次数" ${disabled ? "disabled" : ""}>+</button></div></div>`; }).join("")}</div>
      <div class="plan-summary"><span>预计消耗：阳光 ${plan.sunshine} · 水滴 ${plan.water} · 营养 ${plan.nutrient}</span><strong>${plan.growth ? `预计成长 +${plan.growth}` : plan.actions ? "清除恢复残留" : "请选择操作"}</strong><button class="primary small" data-garden-action="execute-plan" type="button" ${plan.actions && !gardenBusy && !operationDisabled ? "" : "disabled"}>${gardenBusy ? "提交中…" : "确认照顾小树"}</button></div>
    </section>
    ${SpineGuardGardenService.quickTestEnabled ? `<section class="quick-test-panel"><div><strong>开发快速测试</strong><span>只改 Mock 状态，不产生正式奖励</span></div><div class="quick-test-actions">${["seed","sprout","sapling","tree","flower","fruit"].map((key) => `<button class="ghost small" data-quick-scenario="stage:${key}" type="button">${key}</button>`).join("")}<button class="ghost small" data-quick-scenario="tasks:claimable" type="button">任务状态</button><button class="ghost small" data-quick-scenario="resources:rich" type="button">资源 99</button><button class="ghost small" data-quick-scenario="tree:left_lean:mild" type="button">异常 29 秒</button><button class="ghost small" data-quick-scenario="tree:left_lean:warning" type="button">异常 30 秒</button><button class="ghost small" data-quick-scenario="tree:left_lean:severe" type="button">异常 60 秒</button><button class="ghost small" data-quick-scenario="tree:unknown:timeout" type="button">未知超时</button><button class="ghost small" data-quick-scenario="tree:offline" type="button">设备离线</button><button class="ghost small" data-quick-scenario="tree:normal" type="button">设备恢复</button><button class="ghost small" data-quick-scenario="tree:normal:recovery" type="button">待恢复</button><button class="ghost small" data-quick-scenario="rest:299" type="button">休息 4:59</button><button class="ghost small" data-quick-scenario="rest:300" type="button">休息 5:00</button><button class="ghost small" data-quick-scenario="rest:900" type="button">离座 15:00</button><button class="ghost small" data-quick-scenario="cap:179" type="button">日上限 179</button><button class="ghost small" data-quick-scenario="cap:180" type="button">日上限 180</button><button class="ghost small" data-quick-scenario="reset" type="button">重置</button></div></section>` : ""}`;
  gardenTreeController = createGardenTree($("#garden-tree-canvas"));
  gardenTreeController?.setState(getTreeVisualState());
}

function renderGardenFocus(target) {
  const active = SpineGuardFocusTimer.current();
  const summary = SpineGuardFocusTimer.lastCompleted();
  gardenState.activeFocus = active && ["running", "paused"].includes(active.status) ? active : null;
  target.innerHTML = `
    <section class="focus-entry">
      <div><p class="eyebrow">本地专注计时</p><h2>${gardenState.activeFocus ? "有一轮专注可以继续" : "让小树陪你完成一次专注学习"}</h2><p>计时使用本机时间戳并可在刷新后恢复；坐姿、离座和网络断开不会自动暂停。</p><div class="focus-target-actions">${gardenState.activeFocus ? `<button class="primary" data-garden-action="resume-focus" type="button">${gardenState.activeFocus.status === "paused" ? "继续专注" : "返回专注"}</button>` : [15,30,45,60].map((minute) => `<button class="primary small" data-garden-action="start-focus" data-target-minutes="${minute}" type="button">${minute} 分钟</button>`).join("")}</div></div>
      <div class="focus-preview"><span>运行边界</span><strong>仅在本机计时</strong><p>不请求后端专注接口，不生成成长、资源、任务或奖励流水。</p></div>
    </section>
    ${summary ? `<section class="session-summary"><div class="garden-section-head"><div><h2>上次本地专注</h2><p>已完成，未触发后端结算</p></div><strong>${formatDuration(summary.elapsedSeconds)}</strong></div><div class="summary-grid focus-local-summary"><div><span>目标时长</span><strong>${summary.targetMinutes} 分钟</strong></div><div><span>完成用时</span><strong>${formatDuration(summary.elapsedSeconds)}</strong></div><div><span>完成时间</span><strong>${new Date(summary.completedAtMs).toLocaleString("zh-CN", { hour12: false })}</strong></div></div></section>` : ""}`;
}

function renderGardenArchive(target) {
  const rows = gardenState.transactions.map((row) => `<div class="ledger-row">${row.map((cell) => `<span>${cell}</span>`).join("")}</div>`).join("");
  target.innerHTML = `<div class="archive-grid"><section class="garden-section"><div class="garden-section-head"><div><h2>成长时间线</h2><p>解释每一次阶段和资源变化</p></div></div><div class="growth-timeline"><div><time>最近</time><strong>当前成长阶段：${getGardenStage().name}</strong><p>累计成长值 ${gardenState.growth}</p></div><div><time>规则</time><strong>正式奖励由后端结算</strong><p>重复领取和重复结束不会产生第二份奖励</p></div></div></section><section class="garden-section daily-review"><div class="garden-section-head"><div><h2>今日复盘</h2><p>正确时长与提醒概况</p></div></div><div class="review-bars"><div><span>正确坐姿 ${gardenState.dailyCorrectMinutes} 分钟</span><b style="width:${Math.min(100, gardenState.dailyCorrectMinutes / 1.8)}%"></b></div><div><span>最长连续 ${gardenState.continuousCorrectMinutes} 分钟</span><b style="width:${Math.min(100, gardenState.continuousCorrectMinutes / .6)}%"></b></div><div><span>任务已领取 ${gardenState.tasks.filter((item) => item.status === "claimed").length} / ${gardenState.tasks.length}</span><b style="width:${gardenState.tasks.filter((item) => item.status === "claimed").length / gardenState.tasks.length * 100}%"></b></div></div></section></div><section class="garden-section"><div class="garden-section-head"><div><h2>资源流水</h2><p>记录资源与成长变化</p></div></div><div class="ledger"><div class="ledger-row header"><span>时间</span><span>操作</span><span>阳光</span><span>水滴</span><span>营养</span><span>成长</span></div>${rows}</div></section>`;
}

function renderGardenCollection(target) {
  const currentIndex = gardenStages.indexOf(getGardenStage());
  const achievements = [["初次发芽", "达到幼苗期", true], ["挺拔小树", "连续正确坐姿 30 分钟", true], ["阳光伙伴", "累计获得 100 阳光", false], ["耐心园丁", "连续 7 天完成每日任务", false]];
  target.innerHTML = `<section class="collection-hero"><div><p class="eyebrow">阶段收藏</p><h2>已解锁 ${currentIndex + 1} / 6 个成长阶段</h2><p>持续积累正确坐姿时长，见证树木从种子到结果。</p></div><strong>${gardenState.growth}<small>累计成长值</small></strong></section><div class="stage-collection">${gardenStages.map((stage, index) => `<article class="stage-item ${index <= currentIndex ? "unlocked" : "locked"}"><div class="stage-symbol">${["●", "♧", "♣", "♠", "✿", "◆"][index]}</div><strong>${stage.name}</strong><span>${index <= currentIndex ? "已解锁" : `还需 ${Math.max(0, stage.min - gardenState.growth)}`}</span></article>`).join("")}</div><section class="garden-section"><div class="garden-section-head"><div><h2>成长成就</h2><p>只记录值得坚持的正向行为</p></div></div><div class="achievement-list">${achievements.map(([name, desc, unlocked]) => `<div class="achievement ${unlocked ? "unlocked" : ""}"><span>${unlocked ? "✓" : "○"}</span><div><strong>${name}</strong><p>${desc}</p></div></div>`).join("")}</div></section>`;
}

function showGardenToast(message) {
  const toast = $("#garden-toast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.remove("hidden");
  clearTimeout(showGardenToast.timer);
  showGardenToast.timer = setTimeout(() => toast.classList.add("hidden"), 2600);
}

function startFocusSession(targetMinutes = 15, resumeExisting = false) {
  try {
    focusSession = resumeExisting ? SpineGuardFocusTimer.resume() : SpineGuardFocusTimer.start(targetMinutes);
    if (!focusSession || focusSession.status === "completed") return;
    gardenState.activeFocus = focusSession;
    if (!resumeExisting) tickFocusSession.completionShown = false;
  } catch (error) { showGardenToast(error.message); return; }
  $("#focus-mode").classList.remove("hidden");
  document.body.classList.add("focus-open");
  if (focusTreeController) focusTreeController.destroy();
  focusTreeController = createGardenTree($("#focus-tree-canvas"), true);
  updateFocusDisplay();
  clearInterval(startFocusSession.timer);
  startFocusSession.timer = setInterval(tickFocusSession, 1000);
  $("#focus-mode").requestFullscreen?.().catch(() => {});
}

function tickFocusSession() {
  if (!focusSession) return;
  focusSession = SpineGuardFocusTimer.current();
  gardenState.activeFocus = focusSession?.status === "completed" ? null : focusSession;
  updateFocusDisplay();
  if (focusSession?.status === "completed" && !tickFocusSession.completionShown) {
    tickFocusSession.completionShown = true;
    clearInterval(startFocusSession.timer);
    $("#focus-limit-title").textContent = `${focusSession.targetMinutes} 分钟专注已完成`;
    $("#focus-limit-modal")?.classList.remove("hidden");
  }
}

function updateFocusDisplay() {
  if (!focusSession) return;
  const posture = state.posture || postures[0];
  const elapsed = focusSession.elapsedSeconds;
  const guidance = {
    0: ["当前坐姿良好，继续保持", "树叶正在阳光中舒展开"],
    1: ["检测到身体向左侧倾斜", "轻轻调整到坐垫中央，小树会重新舒展开"],
    2: ["检测到身体向右侧倾斜", "放松肩膀，慢慢回到坐垫中央"],
    3: ["检测到身体前倾", "稍微抬头坐直，让小树重新挺拔"],
    4: ["检测到身体后仰", "双脚放稳，轻轻回到自然坐姿"],
    5: ["数据暂时无法稳定识别", "保持自然坐姿，本地专注计时继续"],
    6: ["暂时离座", "小树正在安静等待，本地专注计时继续"],
  }[posture.id] || ["正在识别坐姿", "保持自然放松即可"];
  $("#focus-clock").textContent = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  $("#focus-elapsed").textContent = formatDuration(elapsed);
  $("#focus-correct").textContent = formatDuration(focusSession.remainingSeconds);
  $("#focus-daily").textContent = `${gardenState.dailyCorrectMinutes} 分钟`;
  $("#focus-reminders").textContent = `${gardenState.reminderCount} 次`;
  $("#focus-posture").textContent = guidance[0];
  $("#focus-guidance").textContent = guidance[1];
  $("#focus-milestone").textContent = focusSession.status === "paused"
    ? "专注计时已手动暂停，坐姿数据仍由设备和后端独立处理。"
    : `本地目标 ${focusSession.targetMinutes} 分钟，不触发成长、资源或任务结算。`;
  $("#focus-pause").textContent = focusSession.status === "paused" ? "继续专注" : "暂停专注";
  focusTreeController?.setPosture(posture.id);
}

function toggleFocusPause() {
  if (!focusSession || focusSession.status === "completed") return;
  focusSession = focusSession.status === "paused" ? SpineGuardFocusTimer.resume() : SpineGuardFocusTimer.pause();
  gardenState.activeFocus = focusSession;
  updateFocusDisplay();
}

function closeFocusMode() {
  clearInterval(startFocusSession.timer);
  focusTreeController?.destroy();
  focusTreeController = null;
  focusSession = null;
  $("#focus-mode").classList.add("hidden");
  document.body.classList.remove("focus-open");
  if (document.fullscreenElement) document.exitFullscreen?.();
}

function endFocusSession() {
  if (!focusSession) return;
  const completed = focusSession.status === "completed";
  if (completed) SpineGuardFocusTimer.finishCompleted();
  else SpineGuardFocusTimer.cancel();
  gardenState.activeFocus = null;
  closeFocusMode();
  renderGarden("focus");
  showGardenToast(completed ? "本地专注已完成" : "本次专注已提前结束，未产生结算");
}

function buildPromptForLLM(records) {
  const dataJson = JSON.stringify(records, null, 2);
  return `你是一位严谨、温和、擅长儿童脊柱健康管理的康复医学与姿态评估顾问。请基于 SpineGuard 智能坐垫最近 24 小时的坐姿数据，为家长生成一份清晰、专业、可执行的中文报告。

请注意：
1. 不要做医学确诊，不要声称已经诊断脊柱侧弯。
2. 可以基于压力不对称指数、坐姿类别分布、不良坐姿持续时间提出风险提示。
3. 建议要适合儿童和家庭场景，语言友好，避免制造焦虑。
4. 如果连续异常明显，请建议家长关注桌椅高度、学习时长、休息频率，并在必要时咨询校医或专业医生。

请按以下结构输出：
# 近 24 小时坐姿智能报告
## 1. 总体情况
## 2. 主要问题姿态
## 3. 压力不对称与风险提示
## 4. 纠正建议
## 5. 接下来 7 天观察重点

最近 24 小时数据如下：
${dataJson}`;
}

function createRecentPostureRecords() {
  return Array.from({ length: 24 }, (_, hour) => {
    const posture = postures[Math.floor(Math.random() * postures.length)];
    return {
      hour: `${String(hour).padStart(2, "0")}:00`,
      standardRate: clamp(Math.round(62 + Math.random() * 30 - posture.id * 2), 30, 96),
      mainPosture: posture.name,
      asymmetryIndex: Number(clamp(0.06 + posture.id * 0.028 + Math.random() * 0.06, 0.03, 0.38).toFixed(2)),
      badPostureMinutes: clamp(Math.round(4 + posture.id * 5 + Math.random() * 18), 0, 55),
      reminders: clamp(Math.round(posture.id * 0.8 + Math.random() * 3), 0, 8),
    };
  });
}

async function generateSmartReport() {
  const output = $("#ai-report-output");
  const button = $("#generate-ai-report");
  if (!output) return;
  state.activeReport = null;
  output.classList.remove("rendered");
  output.classList.add("loading");
  output.textContent = "正在请求后端整理数据并生成报告...";
  if (button) button.disabled = true;
  try {
    const studentId = await resolveCurrentStudent(state.currentStudentId);
    if (!studentId) throw new Error("当前登录账号没有可访问的学生档案");
    const student = state.students.find((item) => item.student_id === studentId);
    output.textContent = `正在为 ${student?.display_code || studentId}（${studentId}）生成智能报告...`;
    const requestData = { report_type: "smart", record_limit: 600 };
    const data = await SpineGuardApi.generateReport(studentId, requestData);
    output.classList.remove("loading");
    if (data.ok && data.data) {
      if (data.data.student_id && data.data.student_id !== studentId) {
        throw new Error("后端返回的报告学生与当前登录学生不一致");
      }
      renderReportDetail(data.data, student?.display_code || studentId);
      await renderReport({ reportId: data.data.report_id });
      return;
    }
    throw new Error("后端未返回报告内容");
  } catch (error) {
    output.classList.remove("loading");
    output.classList.remove("rendered");
    const message = String(error.message || "");
    output.textContent = `报告生成失败：${message.includes("No posture records") ? "当前没有可用于生成报告的坐姿记录" : message}`;
  } finally {
    if (button) button.disabled = false;
  }
}

function reportDuration(seconds) {
  const value = Math.max(0, Number(seconds || 0));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const remain = Math.round(value % 60);
  if (hours) return `${hours} 小时 ${minutes} 分钟`;
  if (minutes) return `${minutes} 分钟 ${remain} 秒`;
  return `${remain} 秒`;
}

function reportPercent(value) {
  return `${(Math.max(0, Math.min(1, Number(value || 0))) * 100).toFixed(1)}%`;
}

function reportDateTime(value) {
  if (!value) return "--";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? safeHtml(value)
    : date.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
}

async function copyTextToClipboard(value) {
  const text = String(value || "").trim();
  if (!text) throw new Error("当前报告没有可复制的建议内容");
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.append(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
  const copied = document.execCommand("copy");
  textarea.remove();
  if (copied) return;
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to the user-facing permission error.
    }
  }
  throw new Error("浏览器未允许写入剪贴板");
}

function exportActiveReportPdf() {
  const source = $("#ai-report-output .report-detail");
  if (!source || !state.activeReport) {
    showGardenToast("请先生成或打开一份报告");
    return;
  }
  const printWindow = window.open("", "_blank", "width=960,height=780");
  if (!printWindow) {
    showGardenToast("浏览器阻止了导出窗口，请允许弹出窗口后重试");
    return;
  }
  printWindow.opener = null;
  const clone = source.cloneNode(true);
  clone.querySelector(".report-actions")?.remove();
  const report = state.activeReport.report;
  const title = `${state.activeReport.studentLabel}-${reportTypeLabels[report.report_type] || "坐姿报告"}-${report.period_end || beijingDateText()}`;
  printWindow.document.open();
  printWindow.document.write(`<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title></title><style>
    @page { size: A4; margin: 14mm; }
    * { box-sizing: border-box; }
    body { margin: 0; color: #17323a; background: #fff; font-family: "PingFang SC", "Microsoft YaHei", sans-serif; font-size: 12px; line-height: 1.65; }
    .report-detail { display: grid; gap: 14px; }
    .report-detail > header { display: flex; justify-content: space-between; gap: 18px; padding-bottom: 12px; border-bottom: 2px solid #1db9b3; }
    .report-detail > header > div { display: grid; gap: 3px; }
    .report-detail > header > div:last-child { justify-items: end; text-align: right; }
    h3 { margin: 0; color: #0b555a; font-size: 22px; }
    header span, header small, .report-summary-grid span, .report-posture-breakdown span, .report-posture-breakdown small { color: #58777e; }
    .report-fallback-note { padding: 9px 11px; border-left: 3px solid #d08b20; background: #fff7e7; color: #7b5317; }
    .report-summary-grid, .report-posture-breakdown { display: grid; grid-template-columns: repeat(3, 1fr); border: 1px solid #b7d3d5; }
    .report-summary-grid > div, .report-posture-breakdown > div { display: grid; gap: 3px; padding: 9px; border-right: 1px solid #d6e5e6; border-bottom: 1px solid #d6e5e6; break-inside: avoid; }
    .report-summary-grid strong, .report-posture-breakdown strong { color: #113b43; }
    .report-trend-note, .report-data-range { display: flex; justify-content: space-between; gap: 16px; padding: 9px 0; }
    .report-data-range { padding: 9px 11px; border: 1px solid #b7d3d5; }
    .report-narrative { padding-top: 12px; border-top: 1px solid #b7d3d5; }
    .report-narrative-head > span { color: #087d83; font-weight: 800; }
    .report-markdown h2, .report-markdown h3, .report-markdown h4 { margin: 17px 0 7px; color: #087d83; break-after: avoid; }
    .report-markdown h2 { font-size: 19px; } .report-markdown h3 { font-size: 16px; } .report-markdown h4 { font-size: 14px; }
    .report-markdown p { margin: 7px 0; } .report-markdown strong { color: #b23c57; }
    .report-markdown ul, .report-markdown ol { margin: 8px 0; padding-left: 22px; }
    .report-markdown li { margin: 4px 0; break-inside: avoid; }
    .report-markdown code { padding: 1px 4px; background: #edf6f6; color: #0a6f75; }
    .report-markdown hr { margin: 15px 0; border: 0; border-top: 1px solid #b7d3d5; }
    .report-markdown blockquote { margin: 10px 0; padding: 7px 11px; border-left: 3px solid #1db9b3; background: #eefafa; }
  </style></head><body></body></html>`);
  printWindow.document.close();
  printWindow.document.title = title;
  printWindow.document.body.append(printWindow.document.importNode(clone, true));
  showGardenToast("PDF 导出窗口已打开");
  window.setTimeout(() => {
    printWindow.focus();
    printWindow.print();
  }, 180);
}

function renderReportDetail(report, studentLabel = "当前学生") {
  const output = $("#ai-report-output");
  if (!output || !report) return;
  const summary = report.summary || {};
  const trend = summary.trend || {};
  const postureStats = summary.posture_stats || {};
  const postureRows = Object.entries(reportPostureLabels).map(([key, label]) => {
    const item = postureStats[key] || {};
    return `<div><span>${label}</span><strong>${reportDuration(item.duration_s)}</strong><small>${reportPercent(item.ratio)}</small></div>`;
  }).join("");
  const fallback = report.generated_by === "llm_fallback"
    ? '<div class="report-fallback-note">智能服务暂不可用，本报告已使用后端规则模板生成，统计数据不受影响。</div>' : "";
  output.classList.remove("loading");
  output.classList.add("rendered");
  state.activeReport = { report, studentLabel };
  output.innerHTML = `<article class="report-detail"><header><div><span>${safeHtml(studentLabel)}</span><h3>${safeHtml(reportTypeLabels[report.report_type] || report.report_type)}</h3></div><div><strong>${safeHtml(report.period_start)} 至 ${safeHtml(report.period_end)}</strong><small>${safeHtml(reportSourceLabels[report.generated_by] || report.generated_by || "后端生成")}</small></div></header>${fallback}<div class="report-summary-grid"><div><span>记录数量</span><strong>${Number(summary.record_count || 0)}</strong></div><div><span>有效坐姿</span><strong>${reportDuration(summary.effective_sitting_s ?? summary.total_sitting_s)}</strong></div><div><span>标准坐姿率</span><strong>${reportPercent(summary.normal_ratio)}</strong></div><div><span>提醒次数</span><strong>${Number(summary.reminder_count || 0)} 次</strong></div><div><span>最长连续异常</span><strong>${reportDuration(summary.max_continuous_abnormal_s)}</strong></div><div><span>平均压力不对称</span><strong>${reportPercent(summary.avg_asymmetry_index)}</strong></div></div><div class="report-posture-breakdown">${postureRows}</div><div class="report-trend-note"><strong>${safeHtml(reportTrendLabels[trend.direction] || trend.direction || "数据不足")}：${safeHtml(trend.description || "当前数据尚不足以判断姿态变化趋势。")}</strong>${summary.reminder_peak_day ? `<span>提醒高峰：${safeHtml(summary.reminder_peak_day.date)} · ${Number(summary.reminder_peak_day.count || 0)} 次</span>` : ""}</div>${summary.data_start_at || summary.data_end_at ? `<div class="report-data-range"><span>实际分析数据</span><strong>${reportDateTime(summary.data_start_at)} 至 ${reportDateTime(summary.data_end_at)}</strong></div>` : ""}<div class="report-narrative"><div class="report-narrative-head"><span>坐姿行为分析与建议</span><div class="report-actions"><button class="ghost small" data-report-action="copy" type="button" title="复制坐姿行为分析与建议">复制建议</button><button class="primary small" data-report-action="pdf" type="button" title="将当前完整报告导出为 PDF">导出 PDF</button></div></div><div class="report-markdown"></div></div></article>`;
  const narrative = output.querySelector(".report-markdown");
  if (window.SpineGuardMarkdown?.renderInto) {
    window.SpineGuardMarkdown.renderInto(narrative, report.content || "后端未返回报告正文。");
  } else if (narrative) {
    narrative.textContent = report.content || "后端未返回报告正文。";
  }
}

async function renderReport(targetReport = null) {
  const target = $("#report-content");
  if (!target) return;
  target.innerHTML = '<div class="report-item"><strong>加载中</strong>正在读取后端报告。</div>';
  try {
    const studentId = await resolveCurrentStudent(state.currentStudentId);
    if (!studentId) {
      target.innerHTML = '<div class="report-item"><strong>暂无报告</strong>当前登录账号没有可访问的学生档案。</div>';
      return;
    }
    const result = await SpineGuardApi.reports(studentId);
    const reports = result.items || [];
    const scheduledReports = reports.filter((report) => reportNotification(report));
    state.reports = scheduledReports;
    target.innerHTML = scheduledReports.length
      ? scheduledReports.map((report, index) => {
        const notification = reportNotification(report);
        const unread = !notification.is_read;
        const selected = reportMatchesTarget(report, targetReport);
        const stateLabel = unread ? "未读" : "已读";
        return `<button class="report-item report-record ${unread ? "unread" : "read"} ${selected ? "selected" : ""}" data-report-index="${index}" type="button"><header><strong>${safeHtml(reportTypeLabels[report.report_type] || report.report_type)}</strong><span class="report-read-state">${stateLabel}</span><small>${safeHtml(reportSourceLabels[report.generated_by] || report.generated_by || "后端生成")}</small></header><p>${safeHtml(report.content)}</p><span>${safeHtml(report.period_start)} 至 ${safeHtml(report.period_end)}</span></button>`;
      }).join("")
      : '<div class="report-item report-inbox-empty"><strong>报告箱为空</strong>系统生成日报、周报或月报后，会通过通知送达到这里。</div>';
    if (targetReport) {
      requestAnimationFrame(() => target.querySelector(".report-record.selected")?.scrollIntoView({ behavior: "smooth", block: "center" }));
    }
  } catch (error) {
    target.innerHTML = `<div class="report-item"><strong>加载失败</strong>${error.message}</div>`;
  }
}

function renderRanks() {
  const target = $("#family-rank");
  if (!target) return;
  const rows = [
    ["1", "小雨", "标准坐姿 92%"],
    ["2", "小林", "标准坐姿 88%"],
    ["3", "当前孩子", "标准坐姿 84%"],
    ["4", "小周", "标准坐姿 79%"],
  ];
  target.innerHTML = rows.map((row) => `<div class="rank-row"><strong>${row[0]}</strong><span>${row[1]}</span><small>${row[2]}</small></div>`).join("");
}

function renderNotifications() {
  const list = $("#notification-list");
  if (!list) return;
  const items = state.notifications.length ? state.notifications : [];
  list.innerHTML = items.length ? items
    .map((item) => `<button class="notification-item ${item.is_read ? "read" : "unread"}" data-notification-id="${safeHtml(item.notification_id)}" type="button"><span class="notification-item-head"><strong>${safeHtml(item.title)}</strong><i>${item.is_read ? "已读" : "未读"}</i></span><small>${safeHtml(item.content)}</small>${item.notification_type === "report" ? '<em>打开报告</em>' : ""}</button>`)
    .join("")
    : '<div class="notification-item"><strong>暂无通知</strong><small>后端暂未返回可见通知。</small></div>';
  const unreadCount = items.filter((item) => !item.is_read).length;
  $("#notification-dot")?.classList.add("hidden");
  const count = $("#notification-count");
  if (count) {
    count.textContent = unreadCount > 99 ? "99+" : String(unreadCount);
    count.classList.toggle("hidden", unreadCount === 0);
  }
}

function notificationReportTarget(notification) {
  if (notification?.notification_type !== "report" || notification.related_report_id == null) return null;
  return { studentId: notification.student_id || state.currentStudentId, reportId: notification.related_report_id };
}

function reportMatchesTarget(report, target) {
  if (!target) return false;
  if (target.reportId != null && report.report_id != null) return Number(report.report_id) === Number(target.reportId);
  return report.report_type === target.reportType
    && report.period_start === target.periodStart && report.period_end === target.periodEnd;
}

function reportNotification(report) {
  return state.notifications.find((item) => item.notification_type === "report"
    && item.related_report_id != null && Number(item.related_report_id) === Number(report.report_id));
}

async function markReportRead(report) {
  const notification = reportNotification(report);
  const studentId = report.student_id || state.currentStudentId;
  const detailResult = report.report_id != null
    ? await SpineGuardApi.reportDetail(studentId, report.report_id)
    : { data: report };
  const detail = detailResult.data || detailResult;
  if (notification && !notification.is_read) {
    await SpineGuardApi.readNotification(notification.notification_id);
    await loadNotifications();
  }
  renderReportDetail(detail, state.students.find((item) => item.student_id === studentId)?.display_code || studentId);
  await renderReport({ reportId: detail.report_id });
}

async function loadNotifications() {
  if (!state.token) return;
  try {
    const result = await SpineGuardApi.notifications(false);
    state.notifications = result.items || [];
    state.notificationsUnread = state.notifications.some((item) => !item.is_read);
    renderNotifications();
    if (state.user?.role === "parent" && $("#reports")?.classList.contains("active")) renderReport();
  } catch (error) {
    console.warn("通知同步失败", error);
  }
}

function getNickname() {
  if (!state.user) return "";
  if (state.user.nickname) return state.user.nickname;
  if (state.user.name) return state.user.name;
  return state.user.role === "admin" ? "明德小学管理员" : "林女士";
}

function exerciseVisualMarkup(exercise, large = false) {
  return `<div class="exercise-figure pose-${exercise.pose} ${large ? "large" : ""}">
    <span class="figure-head"></span><span class="figure-torso"></span>
    <span class="figure-arm arm-a"></span><span class="figure-arm arm-b"></span>
    <span class="figure-leg leg-a"></span><span class="figure-leg leg-b"></span>
    <span class="figure-ground"></span><span class="motion-line motion-a"></span><span class="motion-line motion-b"></span>
  </div>`;
}

function exercisePostureLabel(code) {
  return { normal: "标准", left_lean: "左倾", right_lean: "右倾", front_lean: "前倾", back_lean: "后倾" }[code] || "待识别";
}

function renderExerciseRecent() {
  const target = $("#exercise-recent");
  const planTarget = $("#exercise-seven-day");
  if (!target || !planTarget || !window.SpineGuardExerciseGuide) return;
  const local = SpineGuardExerciseGuide.getLocalState();
  const entries = [
    ...(local.recentGuides || []).map((item) => ({ ...item, type: "最近引导" })),
    ...(local.recentViews || []).map((item) => ({ ...item, type: "最近查看" })),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 6);
  target.innerHTML = entries.length ? entries.map((entry) => {
    const names = entry.ids.map((id) => SpineGuardExerciseGuide.getById(id).name).join("、");
    return `<button type="button" data-exercise-id="${entry.ids[0]}"><span>${entry.type}</span><strong>${names}</strong><small>${new Date(entry.at).toLocaleString("zh-CN", { hour12: false })}</small></button>`;
  }).join("") : `<div class="exercise-empty">还没有本地浏览记录</div>`;
  planTarget.innerHTML = SpineGuardExerciseGuide.sevenDayPlan().map((day) => `<div class="${day.guided ? "guided" : ""}"><span>${day.label}</span><strong>${day.guided ? "已引导" : "未引导"}</strong><small>${day.date.slice(5)}</small></div>`).join("");
}

function renderExerciseCenter() {
  if (!window.SpineGuardExerciseGuide) return;
  const context = state.exerciseContext || SpineGuardExerciseGuide.analyze({ latest: state.latestTelemetry });
  const selected = SpineGuardExerciseGuide.getById(state.exerciseSelectedId || context.recommended[0]?.id);
  state.exerciseSelectedId = selected.id;
  const reasonTarget = $("#exercise-reasons");
  if (!reasonTarget) return;
  reasonTarget.innerHTML = context.reasons.map((reason) => `<span>✓ ${reason}</span>`).join("");
  $("#exercise-hero-action").textContent = context.recommended[0]?.name || selected.name;
  const recommendedSeconds = context.recommended.reduce((sum, item) => sum + item.durationSeconds, 0);
  $("#exercise-hero-duration").textContent = `推荐动作 ${context.recommended.length} 个 · 预计 ${Math.max(2, Math.ceil(recommendedSeconds / 60))} 分钟`;
  $("#exercise-data-source").textContent = `${SpineGuardApi.mode === "mock" ? "本地 Mock" : "FastAPI"} · 近期 ${context.sampleCount} 个采样点`;
  $("#exercise-analysis-metrics").innerHTML = [
    ["标准采样", `${context.percentages.normal || 0}%`],
    ["主要偏差", exercisePostureLabel(context.dominantCode)],
    ["有效就坐", `${Math.round(context.sittingSeconds / 60)} 分钟`],
    ["压力偏差", `${Math.round(context.asymmetry * 100)}%`],
    ["今日提醒", `${context.reminderCount} 次`],
  ].map(([label, value]) => `<div><span>${label}</span><strong>${value}</strong></div>`).join("");
  $("#exercise-rule-explanation").textContent = `${context.reasons.join("；")}。因此优先推荐${context.recommended.map((item) => item.name).join("、")}。此结论为透明规则推荐，不是医学诊断。`;
  $("#exercise-recommendations").innerHTML = context.recommended.map((item) => `<article class="exercise-recommend-card ${item.id === selected.id ? "active" : ""}">
    <div class="exercise-card-visual">${exerciseVisualMarkup(item)}</div>
    <div><span>推荐 ${item.score}% · ${item.level}</span><h3>${item.name}</h3><p>${item.target}</p><small>${item.reason} · ${item.durationSeconds} 秒</small></div>
    <button class="ghost small" type="button" data-exercise-id="${item.id}">查看动作</button>
  </article>`).join("");
  $("#exercise-detail").innerHTML = `<div class="exercise-detail-grid">
    <div class="exercise-detail-visual">${exerciseVisualMarkup(selected, true)}<span>${selected.category} · ${selected.level}</span></div>
    <div class="exercise-detail-copy"><p class="eyebrow">动作详情</p><h2>${selected.name}</h2><p>${selected.target} · ${selected.suggestion}</p>
      <ol>${selected.steps.map((step) => `<li>${step}</li>`).join("")}</ol>
      <div class="exercise-caution"><strong>注意事项</strong><span>${selected.caution}</span></div>
      <button class="primary" type="button" data-exercise-guide="${selected.id}">开始动作引导</button>
    </div>
  </div>`;
  const categories = ["全部", ...SpineGuardExerciseGuide.categories];
  $("#exercise-category-tabs").innerHTML = categories.map((category) => `<button class="${state.exerciseCategory === category ? "active" : ""}" type="button" data-exercise-category="${category}">${category}</button>`).join("");
  const items = state.exerciseCategory === "全部" ? SpineGuardExerciseGuide.catalog : SpineGuardExerciseGuide.catalog.filter((item) => item.category === state.exerciseCategory);
  $("#exercise-library").innerHTML = items.map((item) => `<button type="button" data-exercise-id="${item.id}"><div class="exercise-card-visual">${exerciseVisualMarkup(item)}</div><span>${item.category}</span><strong>${item.name}</strong><small>${item.target} · ${item.durationSeconds} 秒</small></button>`).join("");
  renderExerciseRecent();
}

async function loadExerciseCenter() {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  let history = [];
  let daily = null;
  if (state.currentStudentId && state.token) {
    const [historyResult, dailyResult] = await Promise.allSettled([
      SpineGuardApi.studentHistory(state.currentStudentId, { limit: 200 }),
      SpineGuardApi.dailyStats(state.currentStudentId, today),
    ]);
    if (historyResult.status === "fulfilled") history = historyResult.value.items || [];
    if (dailyResult.status === "fulfilled") daily = dailyResult.value.data || null;
  }
  state.exerciseContext = SpineGuardExerciseGuide.analyze({ history, daily, latest: state.latestTelemetry });
  if (!state.exerciseSelectedId) state.exerciseSelectedId = state.exerciseContext.recommended[0]?.id;
  renderExerciseCenter();
}

const exerciseGuideRuntime = { ids: [], index: 0, remaining: 0, total: 0, running: false, timer: null };

function updateExerciseGuide() {
  const item = SpineGuardExerciseGuide.getById(exerciseGuideRuntime.ids[exerciseGuideRuntime.index]);
  if (!item) return;
  $("#exercise-guide-progress").textContent = `动作 ${exerciseGuideRuntime.index + 1} / ${exerciseGuideRuntime.ids.length}`;
  $("#exercise-guide-title").textContent = item.name;
  const elapsed = exerciseGuideRuntime.total - exerciseGuideRuntime.remaining;
  const stepIndex = Math.min(item.steps.length - 1, Math.floor(elapsed / Math.max(1, exerciseGuideRuntime.total / item.steps.length)));
  $("#exercise-guide-step").textContent = item.steps[stepIndex];
  $("#exercise-guide-clock").textContent = formatDuration(exerciseGuideRuntime.remaining);
  $("#exercise-guide-fill").style.width = `${Math.max(0, 100 * elapsed / exerciseGuideRuntime.total)}%`;
  $("#exercise-guide-visual").innerHTML = exerciseVisualMarkup(item, true);
  $("#exercise-guide-toggle").textContent = exerciseGuideRuntime.running ? "暂停" : "继续";
  $("#exercise-guide-prev").disabled = exerciseGuideRuntime.index === 0;
  $("#exercise-guide-next").textContent = exerciseGuideRuntime.index === exerciseGuideRuntime.ids.length - 1 ? "完成引导" : "下一动作";
}

function setExerciseGuideIndex(index) {
  exerciseGuideRuntime.index = Math.max(0, Math.min(index, exerciseGuideRuntime.ids.length - 1));
  const item = SpineGuardExerciseGuide.getById(exerciseGuideRuntime.ids[exerciseGuideRuntime.index]);
  exerciseGuideRuntime.total = item.durationSeconds;
  exerciseGuideRuntime.remaining = item.durationSeconds;
  updateExerciseGuide();
}

function finishExerciseGuide() {
  clearInterval(exerciseGuideRuntime.timer);
  exerciseGuideRuntime.timer = null;
  exerciseGuideRuntime.running = false;
  SpineGuardExerciseGuide.recordGuide(exerciseGuideRuntime.ids);
  $("#exercise-guide-mode").classList.add("hidden");
  $("#exercise-finish-modal").classList.remove("hidden");
  document.body.classList.remove("exercise-open");
  renderExerciseRecent();
}

function stepExerciseGuide(delta) {
  const next = exerciseGuideRuntime.index + delta;
  if (next >= exerciseGuideRuntime.ids.length) { finishExerciseGuide(); return; }
  setExerciseGuideIndex(next);
}

function startExerciseGuide(ids) {
  exerciseGuideRuntime.ids = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
  if (!exerciseGuideRuntime.ids.length) return;
  clearInterval(exerciseGuideRuntime.timer);
  exerciseGuideRuntime.running = true;
  setExerciseGuideIndex(0);
  $("#exercise-guide-mode").classList.remove("hidden");
  $("#exercise-finish-modal").classList.add("hidden");
  document.body.classList.add("exercise-open");
  exerciseGuideRuntime.timer = setInterval(() => {
    if (!exerciseGuideRuntime.running) return;
    exerciseGuideRuntime.remaining -= 1;
    if (exerciseGuideRuntime.remaining <= 0) stepExerciseGuide(1);
    else updateExerciseGuide();
  }, 1000);
}

function closeExerciseGuide() {
  clearInterval(exerciseGuideRuntime.timer);
  exerciseGuideRuntime.timer = null;
  exerciseGuideRuntime.running = false;
  $("#exercise-guide-mode").classList.add("hidden");
  document.body.classList.remove("exercise-open");
}

function renderProfile() {
  if (!state.user) return;
  const nickname = getNickname();
  const isParent = state.user.role === "parent";
  const currentStudent = state.students.find((item) => item.student_id === state.currentStudentId) || state.students[0] || null;
  const explicitDevice = state.devices.find((item) => item.student_id === currentStudent?.student_id);
  const currentDevice = explicitDevice
    || state.devices.find((item) => item.device_id === state.currentDeviceId)
    || (isParent && state.students.length <= 1 ? state.devices[0] : null);
  const binding = isParent ? (currentStudent?.display_code || currentStudent?.student_id || "尚未创建学生档案") : "学校管理账号";
  const device = isParent ? (currentDevice?.device_id || "尚未绑定设备") : `${state.devices.length} 台可管理设备`;
  $("#profile-avatar").textContent = nickname.slice(0, 1);
  $("#profile-name").textContent = nickname;
  $("#profile-role").textContent = roleConfig[state.user.role].label;
  $("#profile-nickname").value = nickname;
  const bindingSelect = $("#profile-binding");
  bindingSelect.replaceChildren();
  if (isParent && state.students.length) {
    state.students.forEach((item) => {
      const option = document.createElement("option");
      option.value = item.student_id;
      option.textContent = `${item.display_code || item.student_id}（${item.student_id}）`;
      option.selected = item.student_id === currentStudent?.student_id;
      bindingSelect.appendChild(option);
    });
  } else {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = isParent ? "尚未创建学生档案" : "学校管理账号不在个人中心绑定设备";
    bindingSelect.appendChild(option);
  }
  bindingSelect.disabled = !isParent || !state.students.length;
  $("#profile-device").value = state.pendingPairing?.deviceId || currentDevice?.device_id || "";
  $("#profile-device").disabled = !isParent;
  $("#profile-bind-code").value = "";
  $("#profile-bind-code").disabled = !isParent;
  $("#save-profile").textContent = isParent ? "保存资料并绑定设备" : "保存昵称";
  const configControls = ["#profile-device-name", "#profile-reminder-mode", "#profile-trigger-seconds", "#profile-cooldown-seconds", "#profile-intensity", "#profile-vibration-enabled", "#load-device-config", "#save-device-config"];
  configControls.forEach((selector) => {
    const control = $(selector);
    if (control) control.disabled = !isParent || !currentDevice;
  });
  const reminderNavigation = $('[data-profile-panel="reminder"]');
  if (reminderNavigation) reminderNavigation.hidden = !isParent;
  if (!isParent && state.profilePanel === "reminder") state.profilePanel = "account";
  const status = $("#profile-device-status");
  status.className = `profile-device-status ${state.deviceBindingMessageType}`.trim();
  status.textContent = state.pendingPairing
    ? `设备 ${state.pendingPairing.deviceId} 正在等待联网登记，认领申请将在 ${new Date(state.pendingPairing.expiresAt).toLocaleTimeString("zh-CN", {hour12: false})} 前有效。`
    : state.deviceBindingMessage || (isParent
    ? (currentDevice
      ? `后端当前返回设备 ${currentDevice.device_id} · ${currentDevice.online_status === "online" ? "在线" : "离线或等待遥测"}${currentDevice.battery_level == null ? "" : ` · 电量 ${currentDevice.battery_level}%`}`
      : "后端当前未返回有效绑定。输入已由管理员注册的硬件编号后可建立绑定。")
    : "管理员请在设备管理页查看全部设备；个人中心不修改设备归属。");
  $("#cancel-device-pairing")?.classList.toggle("hidden", !state.pendingPairing);
  $("#profile-storage-note").textContent = isParent
    ? `${SpineGuardApi.mode === "mock" ? "Mock 数据库" : "SpineGuard 后端"}是设备绑定关系的唯一来源；昵称仍保存在当前浏览器。`
    : "昵称保存在当前浏览器；设备由管理员设备管理功能统一维护。";
  $("#profile-stats").innerHTML = [
    ["账号身份", roleConfig[state.user.role].label],
    ["绑定对象", binding],
    ["设备信息", device],
    ["通知状态", state.notificationsUnread ? "有未读通知" : "全部已读"],
  ].map(([a, b]) => `<div class="profile-stat"><span>${a}</span><strong>${b}</strong></div>`).join("");
  showProfilePanel(state.profilePanel);
  if (state.pendingPairing) schedulePairingPoll();
}

function showProfilePanel(panel) {
  const nextPanel = panel === "reminder" ? "reminder" : "account";
  state.profilePanel = nextPanel;
  $("#profile-account-panel")?.classList.toggle("hidden", nextPanel !== "account");
  $("#profile-reminder-panel")?.classList.toggle("hidden", nextPanel !== "reminder");
  $$("[data-profile-panel]").forEach((button) => {
    button.classList.toggle("active", button.dataset.profilePanel === nextPanel);
  });
}

function setProfileConfigStatus(message, type = "") {
  const target = $("#profile-config-status");
  if (!target) return;
  target.className = `profile-device-status ${type}`.trim();
  target.textContent = message;
}

function applyProfileDeviceConfig(config, appliedVersion = null) {
  if (!config) return;
  const reminder = config.reminder || {};
  $("#profile-device-name").value = config.device_name || "";
  $("#profile-reminder-mode").value = reminder.mode || "normal";
  $("#profile-trigger-seconds").value = Number(reminder.trigger_duration_s || 300);
  $("#profile-cooldown-seconds").value = Number(reminder.cooldown_s || 600);
  $("#profile-intensity").value = Number(reminder.intensity_percent || 40);
  $("#profile-vibration-enabled").checked = reminder.enabled !== false;
  const applied = appliedVersion == null ? null : Number(appliedVersion);
  const configured = Number(config.config_version || 0);
  setProfileConfigStatus(
    applied != null && applied === configured
      ? `配置版本 ${configured} 已由硬件应用。`
      : `后端配置版本 ${configured}${applied == null ? "，等待硬件首次回传应用版本。" : `，硬件当前应用版本 ${applied}，等待下一次轮询同步。`}`,
    applied != null && applied === configured ? "success" : "",
  );
}

async function loadProfileDeviceConfig() {
  const deviceId = $("#profile-device").value.trim() || state.currentDeviceId;
  if (!deviceId) {
    setProfileConfigStatus("请先绑定设备。", "error");
    return null;
  }
  setProfileConfigStatus("正在读取后端设备配置…");
  const response = await SpineGuardApi.deviceConfig(deviceId);
  const device = state.devices.find((item) => item.device_id === deviceId);
  applyProfileDeviceConfig(response.data, device?.applied_config_version);
  return response.data;
}

function persistPendingPairing(pairing) {
  state.pendingPairing = pairing;
  if (pairing) sessionStore.setItem("sg.pending_pairing", JSON.stringify(pairing));
  else sessionStore.removeItem("sg.pending_pairing");
}

function clearPendingPairing() {
  clearTimeout(pairingPollTimer);
  pairingPollTimer = null;
  persistPendingPairing(null);
}

async function completeDeviceBinding({studentId, deviceId, nickname}) {
  clearPendingPairing();
  state.currentStudentId = studentId;
  state.currentDeviceId = deviceId;
  state.user.nickname = nickname || getNickname();
  state.user.binding = state.students.find((item) => item.student_id === studentId)?.display_code || studentId;
  state.user.device = deviceId;
  persistCurrentStudent();
  sessionStore.setItem("sg.device_id", deviceId);
  sessionStore.setItem("sg.user", JSON.stringify(state.user));
  await loadUserContext();
  connectStudentSocket();
  connectGameSocket();
  await Promise.all([updateLiveData(), loadHistoryTrend()]);
  state.deviceBindingMessage = `绑定成功：${studentId} 当前有效设备已切换为 ${deviceId}。旧设备绑定已由后端自动失效。`;
  state.deviceBindingMessageType = "success";
  renderAppState();
  switchTab("profile");
}

function schedulePairingPoll(delay = 2000) {
  if (!state.pendingPairing || pairingPollTimer) return;
  pairingPollTimer = window.setTimeout(async () => {
    pairingPollTimer = null;
    const pending = state.pendingPairing;
    if (!pending) return;
    try {
      const response = await SpineGuardApi.pairingStatus(pending.pairingId);
      const pairing = response.data;
      if (pairing.status === "completed") {
        await completeDeviceBinding(pending);
        return;
      }
      if (pairing.status === "pending") {
        persistPendingPairing({...pending, expiresAt: pairing.expires_at});
        renderProfile();
        return;
      }
      clearPendingPairing();
      state.deviceBindingMessage = {
        expired: "设备认领申请已过期，请重新连接设备热点并读取当前六位认领码。",
        failed: `设备认领失败：${pairing.message || "请重试"}`,
        cancelled: "设备认领申请已取消。",
      }[pairing.status] || `设备认领状态异常：${pairing.status}`;
      state.deviceBindingMessageType = pairing.status === "cancelled" ? "" : "error";
      renderProfile();
    } catch (error) {
      state.deviceBindingMessage = `暂时无法查询认领进度：${error.message}，将继续重试。`;
      state.deviceBindingMessageType = "";
      renderProfile();
    }
  }, delay);
}

function renderTable(target, headers, rows) {
  const el = $(target);
  if (!el) return;
  el.innerHTML = [
    `<div class="table-row header">${headers.map((h) => `<span>${h}</span>`).join("")}</div>`,
    ...rows.map((row) => `<div class="table-row">${row.map((cell) => `<span>${cell}</span>`).join("")}</div>`),
  ].join("");
}

async function renderAdminMetrics() {
  if (!state.token || state.user?.role !== "admin") return;
  await getAdminWorkspace()?.load();
}

async function refreshRoleData() {
  if (!state.user || !state.token) return;
  if (state.user.role === "admin") await getAdminWorkspace()?.load(true);
  else await Promise.all([renderReport(), updateLiveData(), loadHistoryTrend()]);
}

function renderNav() {
  if (!state.user) return;
  const config = roleConfig[state.user.role];
  $("#nav").innerHTML = config.nav
    .map(([tab, label], index) => `<button class="nav-btn ${index === 0 ? "active" : ""}" data-nav="${tab}" type="button">${label}</button>`)
    .join("");
  $$("[data-nav]").forEach((item) => {
    item.addEventListener("click", (event) => {
      event.preventDefault();
      switchTab(item.dataset.nav);
    });
  });
}

function activeTabStorageKey(role = state.user?.role) {
  return role ? `sg.active_tab.${frontendRole(role)}` : "";
}

function restoredTab(role = state.user?.role) {
  const normalizedRole = frontendRole(role);
  const config = roleConfig[normalizedRole];
  if (!config) return "";
  const saved = sessionStore.getItem(activeTabStorageKey(normalizedRole));
  return saved === "profile" || config.nav.some(([id]) => id === saved)
    ? saved
    : config.startTab;
}

function switchTab(tab) {
  if (!state.user) return;
  const allowed = tab === "profile" || roleConfig[state.user.role].nav.some(([id]) => id === tab);
  const target = allowed ? tab : roleConfig[state.user.role].startTab;
  state.activeTab = target;
  sessionStore.setItem(activeTabStorageKey(), target);
  $$(".tab-page").forEach((page) => page.classList.toggle("active", page.id === target));
  $$("#nav .nav-btn").forEach((btn) => btn.classList.toggle("active", btn.dataset.nav === target));
  if (target === "game") renderGarden(gardenView);
  if (target === "exercise") loadExerciseCenter();
  if (target === "reports") renderReport();
}

function setAuthMode(mode) {
  state.authMode = mode;
  $$(".auth-tabs button").forEach((button) => {
    button.classList.toggle("active", button.dataset.authMode === mode);
  });
  $$(".register-field").forEach((field) => field.classList.toggle("hidden", mode !== "register"));
  $("#auth-submit").textContent = mode === "register" ? "注册并进入" : "登录";
  $("#auth-title").textContent = mode === "register" ? "注册平台" : "登录平台";
}

function saveUser(user) {
  user.role = frontendRole(user.role);
  user.nickname = user.nickname || (user.role === "admin" ? "明德小学管理员" : "林女士");
  user.binding = user.binding || (user.role === "admin" ? "明德小学" : "小林同学");
  user.device = state.currentDeviceId || "尚未绑定设备";
  state.user = user;
  sessionStore.setItem("sg.user", JSON.stringify(user));
  renderAppState();
}

function logout() {
  if (liveSocket) liveSocket.close();
  if (gameSocket) gameSocket.close();
  liveSocket = null;
  gameSocket = null;
  liveSocketConnected = false;
  clearTimeout(liveSocketReconnectTimer);
  clearPendingPairing();
  sessionStore.removeItem(studentStorageKey());
  sessionStore.removeItem("sg.user");
  SpineGuardApi.setToken("");
  sessionStore.removeItem("sg.student_id");
  sessionStore.removeItem("sg.device_id");
  sessionStore.removeItem("sg.active_tab.parent");
  sessionStore.removeItem("sg.active_tab.admin");
  state.user = null;
  state.token = "";
  state.students = [];
  state.devices = [];
  state.activeReport = null;
  state.currentStudentId = "";
  state.latestTelemetry = null;
  adminWorkspace = null;
  renderAppState();
}

async function authenticateFromForm() {
  const role = $("#auth-role").value;
  const username = $("#auth-account").value.trim();
  const password = $("#auth-password").value;
  const name = $("#auth-name").value.trim();
  const submit = $("#auth-submit");
  submit.disabled = true;
  submit.textContent = state.authMode === "register" ? "注册中..." : "登录中...";
  try {
    if (state.authMode === "register") {
      await SpineGuardApi.register({username, password, role: backendRole(role)});
    }
    const result = await SpineGuardApi.login(username, password);
    SpineGuardApi.setToken(result.access_token);
    state.token = result.access_token;
    const authenticatedUser = {...result.user, role: frontendRole(result.user.role)};
    const accountChanged = state.user?.user_id && state.user.user_id !== authenticatedUser.user_id;
    state.user = authenticatedUser;
    sessionStore.setItem("sg.user", JSON.stringify(authenticatedUser));
    state.currentStudentId = sessionStore.getItem(studentStorageKey(authenticatedUser.user_id)) || "";
    if (accountChanged) {
      state.currentDeviceId = "";
      state.latestTelemetry = null;
    }
    await loadUserContext();
    if (state.authMode === "register" && role === "parent" && name && !state.students.length) {
      await SpineGuardApi.createStudent({display_code: name, school_id: null, class_id: null});
      await loadUserContext();
    }
    connectStudentSocket();
    connectGameSocket();
    saveUser({
      ...result.user,
      nickname: result.user.username,
      binding: state.students[0]?.display_code || "尚未创建学生档案",
      device: state.currentDeviceId || "尚未绑定设备",
    });
    await Promise.all([updateLiveData(), loadNotifications(), refreshRoleData()]);
  } catch (error) {
    alert(`登录失败：${error.message}`);
  } finally {
    submit.disabled = false;
    submit.textContent = state.authMode === "register" ? "注册并进入" : "登录";
  }
}

function renderAppState() {
  const loggedIn = Boolean(state.user);
  $("#landing").classList.toggle("hidden", loggedIn);
  $("#app").classList.toggle("hidden", !loggedIn);
  if (!loggedIn) return;

  const config = roleConfig[state.user.role];
  const nickname = getNickname();
  $("#session-role").textContent = nickname;
  $("#user-avatar").textContent = nickname.slice(0, 1);
  $("#workspace-label").textContent = config.workspace;
  renderNav();
  $$(".tab-page").forEach((page) => {
    const role = page.dataset.role;
    page.classList.toggle("hidden", role !== "all" && role !== state.user.role);
  });
  renderDashboard();
  renderProfile();
  renderNotifications();
  switchTab(restoredTab(state.user.role));
}

function initEvents() {
  window.addEventListener("spineguard:unauthorized", () => {
    if (state.user) { logout(); alert("登录状态已失效，请重新登录"); }
  });
  $$(".auth-tabs button").forEach((button) => {
    button.addEventListener("click", () => setAuthMode(button.dataset.authMode));
  });
  $$(".demo-accounts button").forEach((button) => {
    button.addEventListener("click", () => {
      const role = button.dataset.demoRole;
      $("#auth-role").value = role;
      $("#auth-account").value = role === "admin" ? "school_admin_demo" : "parent_demo";
      $("#auth-password").value = role === "admin" ? "admin123" : "parent123";
    });
  });
  $("#auth-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    await authenticateFromForm();
  });
  $("#refresh-report")?.addEventListener("click", renderReport);
  $("#generate-ai-report")?.addEventListener("click", generateSmartReport);
  $("#ai-report-output")?.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-report-action]");
    if (!button) return;
    if (button.dataset.reportAction === "pdf") {
      exportActiveReportPdf();
      return;
    }
    if (button.dataset.reportAction === "copy") {
      try {
        const visibleAdvice = $("#ai-report-output .report-markdown")?.innerText || "";
        await copyTextToClipboard(visibleAdvice);
        const originalText = button.textContent;
        button.textContent = "已复制";
        showGardenToast("坐姿分析与建议已复制");
        window.setTimeout(() => { button.textContent = originalText; }, 1600);
      } catch (error) {
        showGardenToast(`复制失败：${error.message}`);
      }
    }
  });
  $("#notification-btn").addEventListener("click", () => {
    $("#notification-menu").classList.toggle("hidden");
    $("#user-menu").classList.add("hidden");
  });
  $("#notification-list")?.addEventListener("click", async (event) => {
    const item = event.target.closest("[data-notification-id]");
    if (!item) return;
    try {
      const notification = state.notifications.find((entry) => entry.notification_id === item.dataset.notificationId);
      const reportTarget = notificationReportTarget(notification);
      if (reportTarget) {
        const detailResult = await SpineGuardApi.reportDetail(reportTarget.studentId, reportTarget.reportId);
        const report = detailResult.data || detailResult;
        if (!notification.is_read) await SpineGuardApi.readNotification(item.dataset.notificationId);
        if (reportTarget.studentId && reportTarget.studentId !== state.currentStudentId) {
          state.currentStudentId = reportTarget.studentId;
          sessionStore.setItem(studentStorageKey(), reportTarget.studentId);
        }
        await loadNotifications();
        $("#notification-menu").classList.add("hidden");
        switchTab("reports");
        renderReportDetail(report, state.students.find((entry) => entry.student_id === report.student_id)?.display_code || report.student_id);
        await renderReport({ reportId: report.report_id });
      } else {
        if (!notification?.is_read) await SpineGuardApi.readNotification(item.dataset.notificationId);
        await loadNotifications();
      }
    } catch (error) {
      alert(`通知更新失败：${error.message}`);
    }
  });
  $("#report-content")?.addEventListener("click", async (event) => {
    const card = event.target.closest("[data-report-index]");
    if (!card) return;
    const report = state.reports[Number(card.dataset.reportIndex)];
    if (!report) return;
    try { await markReportRead(report); }
    catch (error) { alert(`报告状态更新失败：${error.message}`); }
  });
  $("#user-menu-btn").addEventListener("click", () => {
    $("#user-menu").classList.toggle("hidden");
    $("#notification-menu").classList.add("hidden");
  });
  $$("[data-user-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.dataset.userAction;
      $("#user-menu").classList.add("hidden");
      if (action === "profile") switchTab("profile");
      if (action === "switch" || action === "logout") logout();
    });
  });
  $("#save-profile")?.addEventListener("click", async () => {
    if (!state.user) return;
    const button = $("#save-profile");
    const nickname = $("#profile-nickname").value.trim() || getNickname();
    if (state.user.role !== "parent") {
      state.user.nickname = nickname;
      sessionStore.setItem("sg.user", JSON.stringify(state.user));
      state.deviceBindingMessage = "昵称已保存在当前浏览器。";
      state.deviceBindingMessageType = "success";
      renderProfile();
      return;
    }
    const studentId = $("#profile-binding").value;
    const deviceId = $("#profile-device").value.trim();
    const bindCode = $("#profile-bind-code").value.trim();
    if (!studentId) {
      state.deviceBindingMessage = "请先创建或选择需要绑定设备的学生档案。";
      state.deviceBindingMessageType = "error";
      renderProfile();
      return;
    }
    if (!/^[A-Za-z0-9._:-]{1,64}$/.test(deviceId)) {
      state.deviceBindingMessage = "设备编号仅可包含字母、数字、点、下划线、冒号和短横线，最长 64 位。";
      state.deviceBindingMessageType = "error";
      renderProfile();
      return;
    }
    if (bindCode && !/^\d{6}$/.test(bindCode)) {
      state.deviceBindingMessage = "设备认领码必须是六位数字。";
      state.deviceBindingMessageType = "error";
      renderProfile();
      return;
    }
    button.disabled = true;
    button.textContent = bindCode ? "正在发起设备认领…" : "正在兼容绑定旧设备…";
    state.deviceBindingMessage = bindCode ? "正在校验六位认领码并创建配对申请…" : "正在通过旧设备兼容接口更新绑定…";
    state.deviceBindingMessageType = "";
    $("#profile-device-status").className = "profile-device-status";
    $("#profile-device-status").textContent = state.deviceBindingMessage;
    try {
      if (bindCode) {
        const response = await SpineGuardApi.pairDevice({
          device_id: deviceId,
          student_id: studentId,
          claim_code: bindCode,
        });
        const pairing = response.data;
        if (pairing.status === "pending") {
          clearPendingPairing();
          persistPendingPairing({
            pairingId: pairing.pairing_id,
            studentId,
            deviceId,
            nickname,
            expiresAt: pairing.expires_at,
          });
          state.deviceBindingMessage = "";
          state.deviceBindingMessageType = "";
          renderProfile();
          schedulePairingPoll();
          return;
        }
        if (pairing.status !== "completed") throw new Error(pairing.message || `设备认领状态：${pairing.status}`);
      } else {
        await SpineGuardApi.bindDevice({device_id: deviceId, student_id: studentId});
      }
      await completeDeviceBinding({studentId, deviceId, nickname});
    } catch (error) {
      state.deviceBindingMessage = error.status === 404 && !bindCode
        ? `旧设备兼容绑定失败：后端中不存在设备 ${deviceId}。新硬件请填写六位认领码，使用可等待设备上线的配对流程。`
        : `绑定失败：${error.message}`;
      state.deviceBindingMessageType = "error";
      renderProfile();
    } finally {
      button.disabled = false;
      if (document.body.contains(button)) button.textContent = "保存资料并绑定设备";
    }
  });
  $("#cancel-device-pairing")?.addEventListener("click", async () => {
    const pending = state.pendingPairing;
    if (!pending) return;
    try {
      await SpineGuardApi.cancelPairing(pending.pairingId);
      clearPendingPairing();
      state.deviceBindingMessage = "设备认领申请已取消。";
      state.deviceBindingMessageType = "";
      renderProfile();
    } catch (error) {
      state.deviceBindingMessage = `取消认领失败：${error.message}`;
      state.deviceBindingMessageType = "error";
      renderProfile();
    }
  });
  $$("[data-profile-panel]").forEach((button) => {
    button.addEventListener("click", async () => {
      showProfilePanel(button.dataset.profilePanel);
      if (button.dataset.profilePanel !== "reminder" || button.hidden) return;
      try {
        await loadProfileDeviceConfig();
      } catch (error) {
        setProfileConfigStatus(`读取配置失败：${error.message}`, "error");
      }
    });
  });
  $("#load-device-config")?.addEventListener("click", async () => {
    try {
      await loadProfileDeviceConfig();
    } catch (error) {
      setProfileConfigStatus(`读取配置失败：${error.message}`, "error");
    }
  });
  $("#save-device-config")?.addEventListener("click", async () => {
    const deviceId = $("#profile-device").value.trim() || state.currentDeviceId;
    const triggerDuration = Number($("#profile-trigger-seconds").value);
    const cooldown = Number($("#profile-cooldown-seconds").value);
    const intensity = Number($("#profile-intensity").value);
    if (!deviceId) return setProfileConfigStatus("请先绑定设备。", "error");
    if (triggerDuration < 5 || triggerDuration > 3600 || cooldown < 30 || cooldown > 7200 || intensity < 1 || intensity > 100) {
      return setProfileConfigStatus("配置范围不符合后端要求：触发 5～3600 秒、冷却 30～7200 秒、强度 1～100。", "error");
    }
    const button = $("#save-device-config");
    button.disabled = true;
    try {
      setProfileConfigStatus("正在保存到后端；保存成功后仍需等待硬件轮询应用…");
      const response = await SpineGuardApi.updateDeviceConfig(deviceId, {
        device_name: $("#profile-device-name").value.trim() || deviceId,
        enabled: $("#profile-vibration-enabled").checked,
        mode: $("#profile-reminder-mode").value,
        trigger_duration_s: triggerDuration,
        cooldown_s: cooldown,
        intensity_percent: intensity,
      });
      const device = state.devices.find((item) => item.device_id === deviceId);
      if (device) {
        device.device_name = response.data.device_name;
        device.config_version = response.data.config_version;
      }
      applyProfileDeviceConfig(response.data, device?.applied_config_version);
    } catch (error) {
      setProfileConfigStatus(`保存配置失败：${error.message}`, "error");
    } finally {
      button.disabled = false;
    }
  });
  $$("[data-garden-view]").forEach((button) => {
    button.addEventListener("click", () => renderGarden(button.dataset.gardenView));
  });
  $("#garden-view")?.addEventListener("click", async (event) => {
    const quickButton = event.target.closest("[data-quick-scenario]");
    if (quickButton) {
      try {
        const scenario = quickButton.dataset.quickScenario;
        if (scenario === "reset") applyGardenViewModel(await SpineGuardGardenService.reset());
        else {
          const result = await SpineGuardGardenService.quickScenario(state.currentStudentId, scenario);
          if (result && result.growth !== undefined) applyGardenViewModel(result);
        }
        showGardenToast("快速测试场景已切换");
        renderGarden("home");
      } catch (error) { showGardenToast(error.message); }
      return;
    }
    const planButton = event.target.closest("[data-plan-action]");
    if (planButton) {
      gardenApi.adjustPlan(planButton.dataset.planAction, Number(planButton.dataset.planDelta));
      renderGarden("home");
      return;
    }
    const actionButton = event.target.closest("[data-garden-action]");
    if (!actionButton) return;
    const action = actionButton.dataset.gardenAction;
    if (action === "start-focus") startFocusSession(Number(actionButton.dataset.targetMinutes) || 15);
    if (action === "resume-focus") startFocusSession(gardenState.activeFocus?.targetMinutes || 15, true);
    if (action === "execute-plan") {
      gardenBusy = true; renderGarden("home");
      try { await gardenApi.executePlan(); showGardenToast("照顾成功，余额已按服务端结果刷新"); }
      catch (error) { if (error.status === 409) await gardenApi.load(); showGardenToast(error.message); }
      finally { gardenBusy = false; renderGarden("home"); }
    }
    if (action === "claim-task") {
      try { await gardenApi.claimTask(actionButton.dataset.taskId); showGardenToast("任务奖励已领取"); }
      catch (error) { if (error.status === 409) await gardenApi.load(); showGardenToast(error.message); }
      renderGarden("home");
    }
  });
  $("#exercise")?.addEventListener("click", (event) => {
    const categoryButton = event.target.closest("[data-exercise-category]");
    if (categoryButton) {
      state.exerciseCategory = categoryButton.dataset.exerciseCategory;
      renderExerciseCenter();
      return;
    }
    const guideButton = event.target.closest("[data-exercise-guide]");
    if (guideButton) {
      startExerciseGuide(guideButton.dataset.exerciseGuide);
      return;
    }
    const itemButton = event.target.closest("[data-exercise-id]");
    if (itemButton) {
      state.exerciseSelectedId = itemButton.dataset.exerciseId;
      SpineGuardExerciseGuide.recordView(state.exerciseSelectedId);
      renderExerciseCenter();
      $("#exercise-detail-panel")?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  });
  $("#exercise-start-recommended")?.addEventListener("click", () => {
    const ids = state.exerciseContext?.recommended?.map((item) => item.id) || [state.exerciseSelectedId];
    startExerciseGuide(ids);
  });
  $("#exercise-ai-explain")?.addEventListener("click", async () => {
    const button = $("#exercise-ai-explain");
    const status = $("#exercise-ai-status");
    const setStatus = (message) => { if (status) status.textContent = message; };
    if (!state.token) {
      setStatus("当前没有可用的后端学生上下文，继续使用本地规则解释。");
      return;
    }
    button.disabled = true;
    setStatus("正在调用现有智能报告接口…");
    try {
      const studentId = await resolveCurrentStudent(state.currentStudentId);
      if (!studentId) throw new Error("当前登录账号没有可访问的学生档案");
      const result = await SpineGuardApi.generateReport(studentId, { report_type: "smart", record_limit: 600 });
      const report = result.data || {};
      if (report.student_id && report.student_id !== studentId) throw new Error("后端返回的报告学生不一致");
      $("#exercise-rule-explanation").textContent = report.content || $("#exercise-rule-explanation").textContent;
      setStatus(`解读来源：${report.generated_by || "现有报告接口"}。仅用于说明推荐原因。`);
    } catch (error) {
      setStatus(`AI解读暂不可用：${error.message}。已保留透明规则推荐。`);
    } finally {
      button.disabled = false;
    }
  });
  $("#exercise-guide-close")?.addEventListener("click", closeExerciseGuide);
  $("#exercise-guide-prev")?.addEventListener("click", () => stepExerciseGuide(-1));
  $("#exercise-guide-next")?.addEventListener("click", () => stepExerciseGuide(1));
  $("#exercise-guide-toggle")?.addEventListener("click", () => {
    exerciseGuideRuntime.running = !exerciseGuideRuntime.running;
    updateExerciseGuide();
  });
  $("#exercise-finish-return")?.addEventListener("click", () => {
    $("#exercise-finish-modal")?.classList.add("hidden");
    switchTab("exercise");
  });
  $("#focus-pause")?.addEventListener("click", toggleFocusPause);
  $("#focus-end")?.addEventListener("click", endFocusSession);
  $$('[data-focus-limit-action]').forEach((button) => button.addEventListener("click", async () => {
    $("#focus-limit-modal")?.classList.add("hidden");
    if (button.dataset.focusLimitAction === "again") {
      SpineGuardFocusTimer.finishCompleted();
      closeFocusMode();
      tickFocusSession.completionShown = false;
      startFocusSession(15);
    } else endFocusSession();
  }));
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".notification-wrap")) $("#notification-menu")?.classList.add("hidden");
    if (!event.target.closest(".user-wrap")) $("#user-menu")?.classList.add("hidden");
  });
}

async function init() {
  const modeLabel = $("#data-mode-label");
  if (modeLabel) modeLabel.textContent = SpineGuardApi.mode === "mock" ? "数据模式：本地 Mock（无需后端）" : `数据模式：FastAPI（${SpineGuardApi.apiBase}）`;
  buildSeat3D();
  renderTable("#class-table", ["班级", "标准率", "风险人数", "设备"], []);
  renderTable("#risk-table", ["学生", "班级", "分数", "等级"], []);
  renderTable("#device-table", ["设备 ID", "电量", "状态", "固件"], []);
  renderRanks();
  await gardenApi.load();
  renderGarden("home");
  initEvents();
  const cachedUser = state.user;
  if (state.token && cachedUser) renderAppState();
  if (state.token) {
    try {
      const result = await SpineGuardApi.me();
      const backendUser = result.data || result.user || result;
      const sameUser = (!cachedUser?.user_id || cachedUser.user_id === backendUser.user_id)
        && frontendRole(cachedUser?.role) === frontendRole(backendUser.role);
      state.user = {
        ...(sameUser ? cachedUser : {}),
        ...backendUser,
        role: frontendRole(backendUser.role || cachedUser?.role),
      };
      if (!sameUser) {
        state.currentStudentId = sessionStore.getItem(studentStorageKey(state.user.user_id)) || "";
        state.currentDeviceId = "";
        state.latestTelemetry = null;
      }
      sessionStore.setItem("sg.user", JSON.stringify(state.user));
      await loadUserContext();
    } catch (error) {
      if (error?.status === 401) {
        SpineGuardApi.setToken("");
        state.token = "";
        state.user = null;
        sessionStore.removeItem("sg.user");
      } else {
        state.backendError = error?.message || "后端暂时不可用";
        state.user = cachedUser;
      }
    }
  } else {
    state.user = null;
    sessionStore.removeItem("sg.user");
  }
  renderAppState();
  if (state.user) {
    connectStudentSocket();
    connectGameSocket();
    await Promise.all([updateLiveData(), loadNotifications(), refreshRoleData()]);
  }
  scheduleLivePolling();
  window.setInterval(renderAdminMetrics, 30000);
  window.setInterval(loadNotifications, 60000);
}

init();
