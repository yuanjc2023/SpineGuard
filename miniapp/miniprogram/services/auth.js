const api = require('./api');

function login(username, password) {
  return api.request({
    path: '/auth/login',
    method: 'POST',
    auth: false,
    data: { username, password }
  }).then((payload) => {
    wx.setStorageSync('accessToken', payload.access_token);
    wx.setStorageSync('currentUser', payload.user);
    wx.setStorageSync('dataMode', 'api');
    return bootstrapUserContext().then((context) => Object.assign({ user: payload.user }, context));
  });
}

function bootstrapUserContext(options) {
  const preferred = options || {};
  const storedStudent = wx.getStorageSync('currentStudent') || {};
  const storedBinding = wx.getStorageSync('boundDevice') || {};
  return Promise.all([
    api.request({ path: '/students' }),
    api.request({ path: '/devices' })
  ]).then(([studentPayload, devicePayload]) => {
    const students = studentPayload.items || [];
    const devices = devicePayload.items || [];
    const preferredStudentId = preferred.preferredStudentId || storedStudent.student_id;
    const student = students.find((item) => item.student_id === preferredStudentId) || students[0] || null;
    if (!student) return saveUserContext(null, null, students, devices);

    const explicitDeviceId = preferred.preferredDeviceId || '';
    const storedDeviceId = storedBinding.studentId === student.student_id ? storedBinding.deviceCode : '';
    const localCandidate = devices.find((item) => item.device_id === explicitDeviceId)
      || devices.find((item) => item.device_id === storedDeviceId)
      || (devices.length === 1 ? devices[0] : null);

    // 设备列表没有返回 student_id；优先用该学生最新遥测中的 device_id 校准绑定上下文。
    // 新绑定时 preferredDeviceId 优先，避免尚无遥测的新设备被旧遥测覆盖。
    if (explicitDeviceId) return saveUserContext(student, localCandidate, students, devices);
    return api.request({ path: `/students/${encodeURIComponent(student.student_id)}/latest` })
      .then((payload) => {
        const latest = payload && payload.data;
        const latestDeviceId = latest && latest.device_id;
        const telemetryDevice = devices.find((item) => item.device_id === latestDeviceId);
        const telemetryFallback = !localCandidate && latestDeviceId ? deviceFromLatestTelemetry(latest) : null;
        return saveUserContext(student, telemetryDevice || localCandidate || telemetryFallback, students, devices);
      })
      .catch(() => saveUserContext(student, localCandidate, students, devices));
  });
}

function deviceFromLatestTelemetry(latest) {
  const timestamp = Number(latest.timestamp_ms || 0);
  const recentlySeen = timestamp > 0 && Math.abs(Date.now() - timestamp) < 10000;
  return {
    device_id: latest.device_id,
    firmware_version: latest.firmware_version || '',
    model_version: latest.model_version || '',
    battery_level: latest.battery_level,
    online_status: recentlySeen ? 'online' : 'offline',
    last_seen_at: timestamp ? new Date(timestamp).toISOString() : null
  };
}

function saveUserContext(student, device, students, devices) {
  if (student) wx.setStorageSync('currentStudent', student);
  else wx.removeStorageSync('currentStudent');
  if (device) {
    wx.setStorageSync('boundDevice', {
      deviceCode: device.device_id,
      nickName: '脊小树坐姿垫',
      bindTime: '后端账号绑定',
      studentId: student ? student.student_id : ''
    });
    wx.setStorageSync('deviceState', {
      deviceCode: device.device_id,
      nickName: '脊小树坐姿垫',
      connected: device.online_status === 'online',
      battery: device.battery_level == null ? '--' : device.battery_level,
      lastSync: device.last_seen_at || '暂无上传',
      firmware: device.firmware_version || '未知'
    });
  } else {
    wx.removeStorageSync('boundDevice');
    wx.removeStorageSync('deviceState');
  }
  return { student, device, students, devices };
}

function logout() {
  ['accessToken', 'currentUser', 'currentStudent', 'boundDevice', 'deviceState', 'pendingDevicePairing']
    .forEach((key) => wx.removeStorageSync(key));
}

module.exports = { login, bootstrapUserContext, logout };
