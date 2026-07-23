const config = require('../config/env');
const api = require('./api');
const { createMockTelemetry } = require('../mocks/telemetry');
const { mapTelemetry } = require('../utils/mapTelemetry');

function isMockMode() {
  const runtimeMode = wx.getStorageSync('dataMode');
  return runtimeMode ? runtimeMode === 'mock' : (config.mode || (config.useMock ? 'mock' : 'api')) === 'mock';
}

function currentStudentId() {
  const student = wx.getStorageSync('currentStudent') || {};
  return student.student_id || '';
}

function requestLatest(deviceId) {
  const studentId = currentStudentId();
  const path = studentId
    ? `/students/${encodeURIComponent(studentId)}/latest`
    : `/devices/${encodeURIComponent(deviceId)}/latest`;
  return api.request({ path, auth: Boolean(studentId) }).then((payload) => {
    if (!payload || !payload.data) throw new Error('后端尚未收到该设备的遥测数据');
    return payload.data;
  });
}

function requestHistory(deviceId, limit, filters) {
  const studentId = currentStudentId();
  const path = studentId
    ? `/students/${encodeURIComponent(studentId)}/history`
    : `/devices/${encodeURIComponent(deviceId)}/history`;
  return api.request({
    path,
    auth: Boolean(studentId),
    data: Object.assign({ limit }, filters || {})
  }).then((payload) => payload.items || []);
}

function getLatestTelemetry(deviceId) {
  const rawPromise = isMockMode()
    ? Promise.resolve(createMockTelemetry(deviceId))
    : requestLatest(deviceId);
  return rawPromise.then(mapTelemetry);
}

function getTelemetryHistory(deviceId, limit, filters) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 2000));
  if (isMockMode()) {
    const items = [];
    const count = Math.min(safeLimit, 20);
    for (let index = 0; index < count; index++) items.push(mapTelemetry(createMockTelemetry(deviceId)));
    return Promise.resolve(items);
  }
  return requestHistory(deviceId, safeLimit, filters).then((items) => items.map(mapTelemetry));
}

function getDailyStat(date) {
  const studentId = currentStudentId();
  if (!studentId || isMockMode()) return Promise.resolve(null);
  return api.request({
    path: `/students/${encodeURIComponent(studentId)}/stats/daily`,
    data: { date }
  }).then((payload) => payload.data);
}

function getWeeklyStat(week) {
  const studentId = currentStudentId();
  if (!studentId || isMockMode()) return Promise.resolve(null);
  return api.request({
    path: `/students/${encodeURIComponent(studentId)}/stats/weekly`,
    data: { week }
  }).then((payload) => payload.data);
}

function getDeviceStatus(deviceId) {
  if (!deviceId || isMockMode() || !wx.getStorageSync('accessToken')) return Promise.resolve(null);
  // 最新后端的 /devices 列表已包含状态、配置版本和传感器健康。
  // 从授权设备列表取值，也避免依赖旧 status 路由。
  return api.request({ path: '/devices' }).then((payload) => {
    const device = (payload.items || []).find((item) => item.device_id === deviceId);
    if (!device) throw new Error(`后端未返回设备 ${deviceId}，请检查账号绑定关系`);
    return device;
  });
}

function getDeviceConfig(deviceId) {
  if (!deviceId || isMockMode()) return Promise.resolve(null);
  return api.request({ path: `/devices/${encodeURIComponent(deviceId)}/config` }).then((payload) => payload.data);
}

function updateDeviceConfig(deviceId, changes) {
  if (!deviceId || isMockMode()) return Promise.resolve(null);
  return api.request({
    path: `/devices/${encodeURIComponent(deviceId)}/config`,
    method: 'PUT',
    data: changes
  }).then((payload) => payload.data);
}

function pairDevice(deviceId, studentId, claimCode) {
  return api.request({
    path: '/devices/pair',
    method: 'POST',
    data: {
      device_id: deviceId,
      student_id: studentId,
      claim_code: claimCode
    }
  }).then((payload) => payload.data);
}

function getPairingStatus(pairingId) {
  return api.request({
    path: `/devices/pairings/${encodeURIComponent(pairingId)}`
  }).then((payload) => payload.data);
}

function cancelPairing(pairingId) {
  return api.request({
    path: `/devices/pairings/${encodeURIComponent(pairingId)}`,
    method: 'DELETE'
  }).then((payload) => payload.data);
}

function getLocalDeviceStatus() {
  return new Promise((resolve, reject) => {
    wx.request({
      url: 'http://192.168.4.1/api/status',
      method: 'GET',
      timeout: config.requestTimeoutMs,
      success: (response) => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`设备热点返回 HTTP ${response.statusCode}`));
          return;
        }
        const status = response.data || {};
        if (!status.device_id || !/^\d{6}$/.test(String(status.claim_code || ''))) {
          reject(new Error('设备热点未返回有效的 device_id 和六位 claim_code'));
          return;
        }
        resolve(status);
      },
      fail: (error) => reject(new Error(
        `无法访问设备热点：${error.errMsg || '请先连接 SpineGuard Wi-Fi 热点'}`
      ))
    });
  });
}

function getTelemetryMode() {
  return isMockMode() ? 'Mock' : '后端 API';
}

function subscribeStudent(handlers) {
  const studentId = currentStudentId();
  const token = wx.getStorageSync('accessToken');
  if (isMockMode() || !studentId || !token) return null;
  const wsBase = api.apiBase().replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
  const socket = wx.connectSocket({
    url: `${wsBase}/ws/students/${encodeURIComponent(studentId)}?token=${encodeURIComponent(token)}`
  });
  socket.onOpen(() => handlers && handlers.onOpen && handlers.onOpen());
  socket.onMessage((event) => {
    try {
      const raw = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
      if (handlers && handlers.onData) handlers.onData(mapTelemetry(raw));
    } catch (error) {
      if (handlers && handlers.onError) handlers.onError(error);
    }
  });
  socket.onError((error) => handlers && handlers.onError && handlers.onError(error));
  socket.onClose(() => handlers && handlers.onClose && handlers.onClose());
  return socket;
}

module.exports = {
  getLatestTelemetry,
  getTelemetryHistory,
  getDailyStat,
  getWeeklyStat,
  getDeviceStatus,
  getDeviceConfig,
  updateDeviceConfig,
  pairDevice,
  getPairingStatus,
  cancelPairing,
  getLocalDeviceStatus,
  getTelemetryMode,
  subscribeStudent,
  refreshIntervalMs: config.refreshIntervalMs,
  defaultDeviceId: config.defaultDeviceId
};
