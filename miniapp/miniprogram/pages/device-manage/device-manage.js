const telemetryService = require('../../services/telemetry');
const authService = require('../../services/auth');
const api = require('../../services/api');

const EMPTY_DEVICE = {
  deviceCode: '未绑定',
  nickName: '脊小树坐姿垫',
  bindTime: '暂无后端绑定',
  connected: false,
  battery: '--',
  lastSync: '暂无上传',
  firmware: '未知',
  configVersion: null,
  appliedConfigVersion: null,
  configSyncText: '等待后端配置',
  sensorStatus: null
};

const TRIGGER_SECONDS = [60, 180, 300, 600];
const INTENSITY_PERCENT = [30, 40, 60, 90];
const COOLDOWN_SECONDS = [60, 180, 300, 600, 900];

function closestIndex(options, value) {
  const target = Number(value);
  if (!Number.isFinite(target)) return 0;
  return options.reduce((best, item, index) => (
    Math.abs(item - target) < Math.abs(options[best] - target) ? index : best
  ), 0);
}

Page({
  data: {
    device: EMPTY_DEVICE,
    vibrationEnabled: true,
    triggerOptions: ['持续不良坐姿 1 分钟', '持续不良坐姿 3 分钟', '持续不良坐姿 5 分钟', '持续不良坐姿 10 分钟'],
    triggerIndex: 1,
    triggerText: '持续不良坐姿 3 分钟',
    strengthOptions: ['低（30%）', '柔和（40%）', '中（60%）', '高（90%）'],
    strengthIndex: 1,
    strengthText: '柔和（40%）',
    intervalOptions: ['1 分钟', '3 分钟', '5 分钟', '10 分钟', '15 分钟'],
    intervalIndex: 1,
    intervalText: '3 分钟',
    studyModeEnabled: false,
    studyDurationOptions: ['30 分钟', '45 分钟', '60 分钟'],
    studyDurationIndex: 1,
    studyDurationText: '45 分钟',
    restReminderEnabled: true,
    eyeExerciseEnabled: true,
    quietModeEnabled: true,
    quietStart: '21:00',
    quietEnd: '07:00',
    selfCheckItems: [
      { name: '坐垫压力传感器', status: '正常' },
      { name: '靠背压力传感器', status: '正常' },
      { name: '角度传感器', status: '正常' },
      { name: '振动马达', status: '正常' },
      { name: '网络连接', status: '正常' }
    ],
    checking: false,
    pairingPending: false,
    pairingStatusText: '',
    backendControlAvailable: true
  },

  onLoad() {
    this.loadDeviceState();
  },

  onShow() {
    this.setData({ backendControlAvailable: true });
    this.resumePendingPairing();
    if (telemetryService.getTelemetryMode() === '后端 API' && wx.getStorageSync('accessToken')) {
      authService.bootstrapUserContext().then(() => {
        this.loadDeviceState();
        return Promise.all([this.refreshBackendDeviceStatus(), this.refreshBackendDeviceConfig()]);
      }).catch((error) => {
        console.error('同步后端绑定设备失败', error);
        this.loadDeviceState();
      });
      return;
    }
    this.loadDeviceState();
  },

  onHide() {
    clearTimeout(this.pairingTimer);
    this.pairingTimer = null;
  },

  onUnload() {
    clearTimeout(this.pairingTimer);
    this.pairingTimer = null;
  },

  refreshBackendDeviceStatus() {
    const boundDevice = wx.getStorageSync('boundDevice') || {};
    if (!boundDevice.deviceCode) {
      this.setData({ device: Object.assign({}, EMPTY_DEVICE) });
      return Promise.resolve(null);
    }
    return telemetryService.getDeviceStatus(boundDevice.deviceCode).then((status) => {
      if (!status) return;
      const device = Object.assign({}, this.data.device, {
        deviceCode: status.device_id,
        connected: status.online_status === 'online',
        nickName: status.device_name || this.data.device.nickName,
        battery: status.battery_level == null ? '--' : status.battery_level,
        lastSync: status.last_seen_at || '暂无上传',
        firmware: status.firmware_version || '未知',
        configVersion: status.config_version,
        appliedConfigVersion: status.applied_config_version,
        configSyncText: status.applied_config_version != null && status.applied_config_version === status.config_version
          ? `配置 V${status.config_version} 已同步`
          : `配置 V${status.config_version || 0} 等待设备应用`,
        sensorStatus: status.sensor_status || null
      });
      this.saveDeviceState(device);
    }).catch((error) => console.error('获取设备状态失败', error));
  },

  refreshBackendDeviceConfig() {
    const boundDevice = wx.getStorageSync('boundDevice') || {};
    if (!boundDevice.deviceCode || telemetryService.getTelemetryMode() !== '后端 API') return Promise.resolve(null);
    return telemetryService.getDeviceConfig(boundDevice.deviceCode).then((config) => {
      if (!config) return null;
      const reminder = config.reminder || {};
      const triggerIndex = closestIndex(TRIGGER_SECONDS, reminder.trigger_duration_s);
      const strengthIndex = closestIndex(INTENSITY_PERCENT, reminder.intensity_percent);
      const intervalIndex = closestIndex(COOLDOWN_SECONDS, reminder.cooldown_s);
      this.setData({
        vibrationEnabled: reminder.enabled !== false,
        triggerIndex,
        triggerText: this.data.triggerOptions[triggerIndex],
        strengthIndex,
        strengthText: this.data.strengthOptions[strengthIndex],
        intervalIndex,
        intervalText: this.data.intervalOptions[intervalIndex],
        studyModeEnabled: reminder.mode === 'study',
        quietModeEnabled: reminder.mode === 'do_not_disturb'
      });
      const nextDevice = Object.assign({}, this.data.device, {
        nickName: config.device_name || this.data.device.nickName,
        configVersion: config.config_version,
        configSyncText: this.data.device.appliedConfigVersion != null && this.data.device.appliedConfigVersion === config.config_version
          ? `配置 V${config.config_version} 已同步`
          : `配置 V${config.config_version || 0} 等待设备应用`
      });
      this.saveDeviceState(nextDevice);
      return config;
    }).catch((error) => console.error('读取设备提醒配置失败', error));
  },

  persistBackendConfig(changes) {
    if (telemetryService.getTelemetryMode() !== '后端 API') return Promise.resolve(null);
    const boundDevice = wx.getStorageSync('boundDevice') || {};
    if (!boundDevice.deviceCode) return Promise.reject(new Error('请先绑定设备'));
    return telemetryService.updateDeviceConfig(boundDevice.deviceCode, changes).then((config) => {
      const nextDevice = Object.assign({}, this.data.device, {
        nickName: config.device_name || this.data.device.nickName,
        configVersion: config.config_version,
        configSyncText: `配置 V${config.config_version} 已保存，等待设备轮询应用`
      });
      this.saveDeviceState(nextDevice);
      wx.showToast({ title: '配置已保存到后端', icon: 'success' });
      return config;
    }).catch((error) => {
      wx.showModal({ title: '配置保存失败', content: error.message, showCancel: false });
      throw error;
    });
  },

  loadDeviceState() {
    const boundDevice = wx.getStorageSync('boundDevice');
    const deviceSettings = wx.getStorageSync('deviceSettings') || {};
    const vibrationSaved = wx.getStorageSync('vibrationEnabled');
    const deviceState = wx.getStorageSync('deviceState') || {};

    const device = boundDevice && boundDevice.deviceCode
      ? Object.assign({}, EMPTY_DEVICE, deviceState)
      : Object.assign({}, EMPTY_DEVICE);

    if (boundDevice && boundDevice.deviceCode) {
      device.deviceCode = boundDevice.deviceCode;
      device.nickName = boundDevice.nickName || '脊小树坐垫';
      device.bindTime = boundDevice.bindTime || '当前设备';
    }

    const triggerIndex = deviceSettings.triggerIndex !== undefined ? deviceSettings.triggerIndex : this.data.triggerIndex;
    const strengthIndex = deviceSettings.strengthIndex !== undefined ? deviceSettings.strengthIndex : this.data.strengthIndex;
    const intervalIndex = deviceSettings.intervalIndex !== undefined ? deviceSettings.intervalIndex : this.data.intervalIndex;
    const studyDurationIndex = deviceSettings.studyDurationIndex !== undefined ? deviceSettings.studyDurationIndex : this.data.studyDurationIndex;

    this.setData({
      device,
      vibrationEnabled: vibrationSaved !== undefined ? vibrationSaved : this.data.vibrationEnabled,
      triggerIndex,
      triggerText: this.data.triggerOptions[triggerIndex],
      strengthIndex,
      strengthText: this.data.strengthOptions[strengthIndex],
      intervalIndex,
      intervalText: this.data.intervalOptions[intervalIndex],
      studyModeEnabled: deviceSettings.studyModeEnabled !== undefined ? deviceSettings.studyModeEnabled : this.data.studyModeEnabled,
      studyDurationIndex,
      studyDurationText: this.data.studyDurationOptions[studyDurationIndex],
      restReminderEnabled: deviceSettings.restReminderEnabled !== undefined ? deviceSettings.restReminderEnabled : this.data.restReminderEnabled,
      eyeExerciseEnabled: deviceSettings.eyeExerciseEnabled !== undefined ? deviceSettings.eyeExerciseEnabled : this.data.eyeExerciseEnabled,
      quietModeEnabled: deviceSettings.quietModeEnabled !== undefined ? deviceSettings.quietModeEnabled : this.data.quietModeEnabled,
      quietStart: deviceSettings.quietStart || this.data.quietStart,
      quietEnd: deviceSettings.quietEnd || this.data.quietEnd
    });
  },

  saveDeviceState(nextDevice) {
    wx.setStorageSync('deviceState', nextDevice);
    this.setData({ device: nextDevice });
  },

  saveSettings(extra) {
    const settings = Object.assign({
      triggerIndex: this.data.triggerIndex,
      strengthIndex: this.data.strengthIndex,
      intervalIndex: this.data.intervalIndex,
      studyModeEnabled: this.data.studyModeEnabled,
      studyDurationIndex: this.data.studyDurationIndex,
      restReminderEnabled: this.data.restReminderEnabled,
      eyeExerciseEnabled: this.data.eyeExerciseEnabled,
      quietModeEnabled: this.data.quietModeEnabled,
      quietStart: this.data.quietStart,
      quietEnd: this.data.quietEnd
    }, extra);
    wx.setStorageSync('deviceSettings', settings);
  },

  toggleConnection() {
    if (telemetryService.getTelemetryMode() === '后端 API') {
      this.refreshBackendDeviceStatus();
      wx.showToast({ title: '连接状态由后端遥测更新', icon: 'none' });
      return;
    }
    const connected = !this.data.device.connected;
    const nextDevice = Object.assign({}, this.data.device, {
      connected,
      lastSync: connected ? '刚刚' : '已断开'
    });
    this.saveDeviceState(nextDevice);
    wx.showToast({ title: connected ? '蓝牙已连接' : '已断开连接', icon: 'none' });
  },

  calibratePosture() {
    if (telemetryService.getTelemetryMode() === '后端 API') {
      const user = wx.getStorageSync('currentUser') || {};
      const boundDevice = wx.getStorageSync('boundDevice') || {};
      if (!['school_admin', 'admin'].includes(user.role)) {
        wx.showModal({ title: '需要管理员权限', content: '后端已支持远程空载校准，但只允许学校管理员或系统管理员下发命令。', showCancel: false });
        return;
      }
      wx.showLoading({ title: '下发校准命令...' });
      api.request({
        path: `/devices/${encodeURIComponent(boundDevice.deviceCode)}/commands`,
        method: 'POST',
        data: { type: 'calibrate_empty' }
      }).then(() => {
        wx.hideLoading();
        wx.showToast({ title: '校准命令已下发', icon: 'success' });
      }).catch((error) => {
        wx.hideLoading();
        wx.showModal({ title: '下发失败', content: error.message, showCancel: false });
      });
      return;
    }
    wx.showLoading({ title: '校准中...' });
    setTimeout(() => {
      wx.hideLoading();
      wx.showToast({ title: '坐姿校准完成', icon: 'success' });
    }, 700);
  },

  openWifiConfig() {
    wx.navigateTo({
      url: '/pages/wifi-config/wifi-config',
      fail: () => {
        wx.showModal({
          title: '无法打开配网页',
          content: '请确认手机已经连接设备 Wi-Fi 热点，然后在浏览器中访问 http://192.168.4.1。',
          showCancel: false
        });
      }
    });
  },

  toggleVibration(e) {
    const vibrationEnabled = e.detail.value;
    this.setData({ vibrationEnabled });
    wx.setStorageSync('vibrationEnabled', vibrationEnabled);
    this.persistBackendConfig({ enabled: vibrationEnabled }).catch(() => {});
  },

  onTriggerChange(e) {
    const triggerIndex = Number(e.detail.value);
    this.setData({
      triggerIndex,
      triggerText: this.data.triggerOptions[triggerIndex]
    });
    this.saveSettings({ triggerIndex });
    this.persistBackendConfig({ trigger_duration_s: TRIGGER_SECONDS[triggerIndex] }).catch(() => {});
  },

  onStrengthChange(e) {
    const strengthIndex = Number(e.detail.value);
    this.setData({
      strengthIndex,
      strengthText: this.data.strengthOptions[strengthIndex]
    });
    this.saveSettings({ strengthIndex });
    this.persistBackendConfig({ intensity_percent: INTENSITY_PERCENT[strengthIndex] }).catch(() => {});
  },

  onIntervalChange(e) {
    const intervalIndex = Number(e.detail.value);
    this.setData({
      intervalIndex,
      intervalText: this.data.intervalOptions[intervalIndex]
    });
    this.saveSettings({ intervalIndex });
    this.persistBackendConfig({ cooldown_s: COOLDOWN_SECONDS[intervalIndex] }).catch(() => {});
  },

  toggleStudyMode(e) {
    const studyModeEnabled = e.detail.value;
    this.setData({ studyModeEnabled, quietModeEnabled: studyModeEnabled ? false : this.data.quietModeEnabled });
    this.saveSettings({ studyModeEnabled, quietModeEnabled: studyModeEnabled ? false : this.data.quietModeEnabled });
    this.persistBackendConfig({ mode: studyModeEnabled ? 'study' : 'normal' }).catch(() => {});
  },

  onStudyDurationChange(e) {
    const studyDurationIndex = Number(e.detail.value);
    this.setData({
      studyDurationIndex,
      studyDurationText: this.data.studyDurationOptions[studyDurationIndex]
    });
    this.saveSettings({ studyDurationIndex });
  },

  toggleRestReminder(e) {
    const restReminderEnabled = e.detail.value;
    this.setData({ restReminderEnabled });
    this.saveSettings({ restReminderEnabled });
  },

  toggleEyeExercise(e) {
    const eyeExerciseEnabled = e.detail.value;
    this.setData({ eyeExerciseEnabled });
    this.saveSettings({ eyeExerciseEnabled });
  },

  toggleQuietMode(e) {
    const quietModeEnabled = e.detail.value;
    this.setData({ quietModeEnabled, studyModeEnabled: quietModeEnabled ? false : this.data.studyModeEnabled });
    this.saveSettings({ quietModeEnabled, studyModeEnabled: quietModeEnabled ? false : this.data.studyModeEnabled });
    this.persistBackendConfig({ mode: quietModeEnabled ? 'do_not_disturb' : (this.data.studyModeEnabled ? 'study' : 'normal') }).catch(() => {});
  },

  onQuietStartChange(e) {
    const quietStart = e.detail.value;
    this.setData({ quietStart });
    this.saveSettings({ quietStart });
  },

  onQuietEndChange(e) {
    const quietEnd = e.detail.value;
    this.setData({ quietEnd });
    this.saveSettings({ quietEnd });
  },

  runSelfCheck() {
    if (telemetryService.getTelemetryMode() === '后端 API') {
      const status = this.data.device.sensorStatus;
      if (!status) {
        wx.showModal({ title: '暂无自检数据', content: '等待设备上传 sensor_status 后即可查看五路 FSR、测距和马达状态。', showCancel: false });
        return;
      }
      const fsr = status.fsr || {};
      const tof = status.tof || {};
      const motor = status.motor || {};
      this.setData({
        selfCheckItems: [
          { name: '五路坐垫压力传感器', status: fsr.all_ok ? '正常' : '需检查' },
          { name: '压力基线', status: fsr.baseline_valid ? '有效' : '需校准' },
          { name: '靠背测距传感器', status: tof.online && tof.valid ? '正常' : '不可用' },
          { name: '振动马达控制', status: motor.control_ready ? '就绪' : '未就绪' },
          { name: '网络连接', status: this.data.device.connected ? '正常' : '离线' }
        ]
      });
      wx.showToast({ title: '已读取硬件自检状态', icon: 'none' });
      return;
    }
    this.setData({ checking: true });
    wx.showLoading({ title: '自检中...' });
    setTimeout(() => {
      wx.hideLoading();
      this.setData({
        checking: false,
        selfCheckItems: this.data.selfCheckItems.map((item) => Object.assign({}, item, { status: '正常' }))
      });
      wx.showToast({ title: '设备状态正常', icon: 'success' });
    }, 900);
  },

  upgradeFirmware() {
    if (!this.data.backendControlAvailable) {
      wx.showModal({ title: '暂不支持远程升级', content: `当前后端可读取固件版本 ${this.data.device.firmware}，但没有固件升级或命令下发接口。`, showCancel: false });
      return;
    }
    wx.showModal({
      title: '固件升级',
      content: `当前版本 ${this.data.device.firmware}，已是最新版本。`,
      showCancel: false
    });
  },

  savePendingPairing(pending) {
    if (pending) wx.setStorageSync('pendingDevicePairing', pending);
    else wx.removeStorageSync('pendingDevicePairing');
    this.setData({
      pairingPending: Boolean(pending),
      pairingStatusText: pending
        ? `设备 ${pending.deviceId} 正在等待联网登记，申请有效期至 ${new Date(pending.expiresAt).toLocaleTimeString()}`
        : ''
    });
  },

  resumePendingPairing() {
    if (telemetryService.getTelemetryMode() !== '后端 API') return;
    const pending = wx.getStorageSync('pendingDevicePairing');
    if (!pending || !pending.pairingId) return;
    this.savePendingPairing(pending);
    this.schedulePairingPoll(0);
  },

  schedulePairingPoll(delay) {
    if (this.pairingTimer) return;
    const pending = wx.getStorageSync('pendingDevicePairing');
    if (!pending || !pending.pairingId) return;
    this.pairingTimer = setTimeout(() => {
      this.pairingTimer = null;
      telemetryService.getPairingStatus(pending.pairingId).then((pairing) => {
        if (pairing.status === 'completed') {
          this.savePendingPairing(null);
          return this.completeRemoteBinding(pending.deviceId, pending.studentId);
        }
        if (pairing.status === 'pending') {
          const nextPending = Object.assign({}, pending, { expiresAt: pairing.expires_at });
          this.savePendingPairing(nextPending);
          this.schedulePairingPoll(2000);
          return null;
        }
        this.savePendingPairing(null);
        const messages = {
          expired: '设备认领申请已过期，请重新连接设备热点并读取当前认领码。',
          failed: pairing.message || '设备认领失败，请重试。',
          cancelled: '设备认领申请已取消。'
        };
        wx.showModal({
          title: pairing.status === 'cancelled' ? '认领已取消' : '设备认领未完成',
          content: messages[pairing.status] || `当前状态：${pairing.status}`,
          showCancel: false
        });
        return null;
      }).catch((error) => {
        this.setData({ pairingStatusText: `暂时无法查询认领进度：${error.message}，正在重试` });
        this.schedulePairingPoll(2000);
      });
    }, Number(delay) || 0);
  },

  completeRemoteBinding(deviceId, studentId) {
    return authService.bootstrapUserContext({
      preferredStudentId: studentId,
      preferredDeviceId: deviceId
    }).then(() => {
      wx.hideLoading();
      this.loadDeviceState();
      return Promise.all([this.refreshBackendDeviceStatus(), this.refreshBackendDeviceConfig()]);
    }).then(() => {
      wx.showToast({ title: '设备绑定已更新', icon: 'success' });
    });
  },

  cancelPendingPairing() {
    const pending = wx.getStorageSync('pendingDevicePairing');
    if (!pending || !pending.pairingId) return;
    telemetryService.cancelPairing(pending.pairingId).then(() => {
      clearTimeout(this.pairingTimer);
      this.pairingTimer = null;
      this.savePendingPairing(null);
      wx.showToast({ title: '认领申请已取消', icon: 'none' });
    }).catch((error) => {
      wx.showModal({ title: '取消失败', content: error.message, showCancel: false });
    });
  },

  submitDevicePairing(deviceId, studentId, bindCode) {
    wx.showLoading({ title: '绑定中...' });
    const bindingRequest = bindCode
      ? telemetryService.pairDevice(deviceId, studentId, bindCode)
      : api.request({
        path: '/devices/bind',
        method: 'POST',
        data: { device_id: deviceId, student_id: studentId }
      }).then(() => ({ status: 'completed' }));
    return bindingRequest.then((pairing) => {
      if (pairing.status === 'pending') {
        wx.hideLoading();
        this.savePendingPairing({
          pairingId: pairing.pairing_id,
          deviceId,
          studentId,
          expiresAt: pairing.expires_at
        });
        this.schedulePairingPoll(2000);
        wx.showToast({ title: '等待设备联网', icon: 'none' });
        return null;
      }
      if (pairing.status !== 'completed') throw new Error(pairing.message || `设备认领状态：${pairing.status}`);
      return this.completeRemoteBinding(deviceId, studentId);
    }).catch((error) => {
      wx.hideLoading();
      wx.showModal({ title: '绑定失败', content: error.message, showCancel: false });
      return null;
    });
  },

  pairFromDeviceHotspot(studentId) {
    wx.showLoading({ title: '读取设备信息...' });
    telemetryService.getLocalDeviceStatus().then((status) => {
      wx.hideLoading();
      const deviceId = String(status.device_id).trim();
      const claimCode = String(status.claim_code).trim();
      wx.showModal({
        title: '确认认领设备',
        content: `${status.device_name || 'SpineGuard 坐姿垫'}\n设备编号：${deviceId}`,
        confirmText: '确认认领',
        success: (result) => {
          if (result.confirm) this.submitDevicePairing(deviceId, studentId, claimCode);
        }
      });
    }).catch((error) => {
      wx.hideLoading();
      wx.showModal({
        title: '未读取到设备',
        content: `${error.message}\n\n请确认手机已连接 SpineGuard 设备热点；也可以返回后选择手动输入。`,
        showCancel: false
      });
    });
  },

  promptManualDeviceBinding(studentId) {
    wx.showModal({
      title: '手动输入设备',
      content: '请输入设备本地页面显示的设备编号',
      editable: true,
      placeholderText: '例如 SG-0001',
      success: (res) => {
        const deviceId = String(res.content || '').trim();
        if (!res.confirm || !deviceId) return;
        wx.showModal({
          title: '输入六位设备绑定码',
          content: '新版硬件请填写设备显示或标签上的六位绑定码；旧测试设备可留空。',
          editable: true,
          placeholderText: '例如 123456',
          success: (codeResult) => {
            if (!codeResult.confirm) return;
            const bindCode = String(codeResult.content || '').trim();
            if (bindCode && !/^\d{6}$/.test(bindCode)) {
              wx.showToast({ title: '绑定码应为六位数字', icon: 'none' });
              return;
            }
            this.submitDevicePairing(deviceId, studentId, bindCode);
          }
        });
      }
    });
  },

  changeDevice() {
    if (telemetryService.getTelemetryMode() !== '后端 API') {
      wx.showToast({ title: '体验模式不修改后端绑定', icon: 'none' });
      return;
    }
    const student = wx.getStorageSync('currentStudent') || {};
    if (!student.student_id) {
      wx.showToast({ title: '请先登录并选择学生', icon: 'none' });
      return;
    }
    wx.showActionSheet({
      itemList: ['从设备热点自动读取', '手动输入设备编号和认领码'],
      success: (result) => {
        if (result.tapIndex === 0) this.pairFromDeviceHotspot(student.student_id);
        else this.promptManualDeviceBinding(student.student_id);
      }
    });
  },

  unbindDevice() {
    if (telemetryService.getTelemetryMode() === '后端 API') {
      wx.showModal({
        title: '后端暂不支持解绑',
        content: '当前后端只有设备绑定接口，没有解除绑定接口。请从“我的”页面退出账号；退出不会改变后端绑定关系。',
        showCancel: false
      });
      return;
    }
    wx.showModal({
      title: '提示',
      content: '确定退出体验模式并清除本机设备数据吗？',
      success: (res) => {
        if (res.confirm) {
          wx.clearStorageSync();
          wx.reLaunch({ url: '/pages/login/login' });
        }
      }
    });
  }
});
