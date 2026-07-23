const telemetryService = require('../../services/telemetry');
const gardenService = require('../../services/garden');

const FOCUS_TARGETS = [15, 30, 45, 60];
const STAGES = {
  seed: { key: 'seed', name: '种子期' },
  sprout: { key: 'sprout', name: '幼苗期' },
  sapling: { key: 'sapling', name: '小树期' },
  tree: { key: 'tree', name: '大树期' },
  flower: { key: 'flower', name: '开花期' },
  fruit: { key: 'fruit', name: '结果期' }
};
const POSTURES = {
  normal: { name: '标准坐姿', icon: '✨', treeClass: 'normal', message: '坐姿稳定，小树正在陪你专注。' },
  left_lean: { name: '左侧倾斜', icon: '↙️', treeClass: 'left-lean', message: '身体稍向左倾，请轻轻回到坐垫中央。' },
  right_lean: { name: '右侧倾斜', icon: '↘️', treeClass: 'right-lean', message: '身体稍向右倾，请轻轻回到坐垫中央。' },
  front_lean: { name: '身体前倾', icon: '🥀', treeClass: 'front-lean', message: '抬头放松肩膀，胸口与桌沿留些距离。' },
  back_lean: { name: '身体后倾', icon: '🌿', treeClass: 'back-lean', message: '双脚放稳，回到自然、舒适的坐姿。' },
  empty: { name: '暂时离座', icon: '🪑', treeClass: 'empty', message: '当前无人就坐，专注计时仍会继续。' },
  unknown: { name: '等待识别', icon: '◌', treeClass: 'unknown', message: '请坐稳片刻，正在识别当前坐姿。' },
  offline: { name: '设备离线', icon: '📴', treeClass: 'offline', message: '坐姿数据暂不可用，专注计时不受影响。' }
};

function formatTime(seconds) {
  const safe = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}

Page({
  data: {
    focus: null,
    stage: STAGES.sapling,
    postureCode: 'unknown',
    posture: POSTURES.unknown,
    remainingText: '00:00',
    elapsedText: '00:00',
    targetText: '--',
    progressPercent: 0,
    timerStatusText: '准备开始',
    deviceConnected: false,
    connectionText: '正在连接坐垫',
    syncText: '等待实时数据',
    batteryText: '--',
    balanceText: '等待压力数据',
    busy: false
  },

  onLoad(options) {
    const requested = Number(options && options.minutes);
    this.requestedMinutes = FOCUS_TARGETS.includes(requested) ? requested : null;
    this.initializePage();
  },

  onShow() {
    this.pageVisible = true;
    this.startClock();
    this.startTelemetryRefresh();
    this.startRealtimeTelemetry();
  },

  onHide() {
    this.pageVisible = false;
    this.stopClock();
    this.stopTelemetryRefresh();
    this.stopRealtimeTelemetry();
  },

  onUnload() {
    this.pageVisible = false;
    this.stopClock();
    this.stopTelemetryRefresh();
    this.stopRealtimeTelemetry();
  },

  initializePage() {
    const focusPromise = this.requestedMinutes
      ? gardenService.startFocus(this.requestedMinutes)
      : gardenService.currentFocus();
    Promise.all([
      focusPromise,
      gardenService.getGarden().catch(() => null)
    ]).then(([focus, garden]) => {
      if (!focus) {
        wx.showToast({ title: '请先选择专注时长', icon: 'none' });
        setTimeout(() => wx.navigateBack(), 500);
        return;
      }
      if (garden && STAGES[garden.stage]) this.setData({ stage: STAGES[garden.stage] });
      this.applyFocus(focus);
    }).catch((error) => {
      wx.showToast({ title: error.message || '专注模式启动失败', icon: 'none' });
    });
  },

  startClock() {
    this.stopClock();
    this.refreshFocus();
    this.clockTimer = setInterval(() => this.refreshFocus(), 500);
  },

  stopClock() {
    if (this.clockTimer) clearInterval(this.clockTimer);
    this.clockTimer = null;
  },

  refreshFocus() {
    gardenService.currentFocus().then((focus) => {
      if (focus) this.applyFocus(focus);
    }).catch(() => {});
  },

  applyFocus(focus) {
    const targetSeconds = Math.max(1, Number(focus.targetMinutes) * 60);
    const progressPercent = Math.max(0, Math.min(100, Math.round(Number(focus.elapsedSeconds) / targetSeconds * 100)));
    const timerStatusText = focus.status === 'paused' ? '已暂停'
      : focus.status === 'completed' ? '本轮已完成'
        : '专注进行中';
    this.setData({
      focus,
      remainingText: formatTime(focus.remainingSeconds),
      elapsedText: formatTime(focus.elapsedSeconds),
      targetText: `${focus.targetMinutes} 分钟`,
      progressPercent,
      timerStatusText
    });
    if (focus.status === 'completed' && this.completedModalTimerId !== focus.timerId) {
      this.completedModalTimerId = focus.timerId;
      this.stopClock();
      wx.showModal({
        title: `${focus.targetMinutes} 分钟专注完成`,
        content: '现在可以起身活动一下。',
        cancelText: '结束休息',
        confirmText: '再来一轮',
        success: (res) => {
          if (res.confirm) this.restartFocus(focus.targetMinutes);
          else gardenService.endFocus(focus.timerId).finally(() => wx.navigateBack());
        }
      });
    }
  },

  toggleFocus() {
    if (!this.data.focus || this.data.busy) return;
    this.setData({ busy: true });
    const operation = this.data.focus.status === 'paused' ? gardenService.resumeFocus : gardenService.pauseFocus;
    operation().then((focus) => this.applyFocus(focus))
      .catch((error) => wx.showToast({ title: error.message, icon: 'none' }))
      .finally(() => this.setData({ busy: false }));
  },

  restartFocus(minutes) {
    this.setData({ busy: true });
    gardenService.startFocus(minutes).then((focus) => {
      this.completedModalTimerId = null;
      this.applyFocus(focus);
      this.startClock();
    }).catch((error) => wx.showToast({ title: error.message, icon: 'none' }))
      .finally(() => this.setData({ busy: false }));
  },

  endFocus() {
    const focus = this.data.focus;
    if (!focus || this.data.busy) return;
    wx.showModal({
      title: '结束本轮专注？',
      confirmText: '结束',
      confirmColor: '#D76A62',
      success: (res) => {
        if (!res.confirm) return;
        this.setData({ busy: true });
        gardenService.endFocus(focus.timerId).then(() => wx.navigateBack())
          .catch((error) => wx.showToast({ title: error.message, icon: 'none' }))
          .finally(() => this.setData({ busy: false }));
      }
    });
  },

  startTelemetryRefresh() {
    if (this.telemetryTimer) return;
    this.refreshTelemetry().catch(() => {});
    this.telemetryTimer = setInterval(() => this.refreshTelemetry().catch(() => {}), telemetryService.refreshIntervalMs);
  },

  stopTelemetryRefresh() {
    if (this.telemetryTimer) clearInterval(this.telemetryTimer);
    this.telemetryTimer = null;
  },

  startRealtimeTelemetry() {
    if (this.realtimeSocket || telemetryService.getTelemetryMode() === 'Mock') return;
    this.realtimeSocket = telemetryService.subscribeStudent({
      onOpen: () => {
        this.reconnectDelay = 2000;
        this.stopTelemetryRefresh();
        this.setData({ connectionText: '坐垫已连接', syncText: 'WebSocket 实时同步', deviceConnected: true });
      },
      onData: (telemetry) => this.applyTelemetry(telemetry),
      onError: (error) => console.warn('专注页实时连接异常，将回退轮询', error),
      onClose: () => {
        this.realtimeSocket = null;
        if (!this.pageVisible) return;
        this.startTelemetryRefresh();
        clearTimeout(this.reconnectTimer);
        const delay = this.reconnectDelay || 2000;
        this.reconnectTimer = setTimeout(() => this.startRealtimeTelemetry(), delay);
        this.reconnectDelay = Math.min(30000, delay * 2);
      }
    });
  },

  stopRealtimeTelemetry() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.realtimeSocket) this.realtimeSocket.close({ code: 1000, reason: 'page hidden' });
    this.realtimeSocket = null;
  },

  refreshTelemetry() {
    const boundDevice = wx.getStorageSync('boundDevice') || {};
    const deviceId = boundDevice.deviceCode || telemetryService.defaultDeviceId;
    return telemetryService.getLatestTelemetry(deviceId)
      .then((telemetry) => this.applyTelemetry(telemetry))
      .catch((error) => {
        this.applyOffline();
        throw error;
      });
  },

  applyTelemetry(telemetry) {
    const code = POSTURES[telemetry.postureCode] ? telemetry.postureCode : 'unknown';
    const pressure = telemetry.pressure || {};
    const lrTotal = Math.max(1, Number(pressure.left || 0) + Number(pressure.right || 0));
    const fbTotal = Math.max(1, Number(pressure.front || 0) + Number(pressure.back || 0));
    const lrRatio = (Number(pressure.left || 0) - Number(pressure.right || 0)) / lrTotal;
    const fbRatio = (Number(pressure.front || 0) - Number(pressure.back || 0)) / fbTotal;
    let balanceText = '压力分布较均衡';
    if (Math.abs(lrRatio) >= 0.12) balanceText = lrRatio > 0 ? '左侧压力偏高' : '右侧压力偏高';
    else if (Math.abs(fbRatio) >= 0.12) balanceText = fbRatio > 0 ? '前侧压力偏高' : '后侧压力偏高';
    this.setData({
      postureCode: code,
      posture: POSTURES[code],
      deviceConnected: true,
      connectionText: '坐垫已连接',
      syncText: `刚刚同步 · ${telemetryService.getTelemetryMode()}`,
      batteryText: telemetry.batteryLevel == null ? '--' : `${telemetry.batteryLevel}%`,
      balanceText
    });
    wx.setStorageSync('currentPosture', telemetry.postureName);
    wx.setStorageSync('currentPostureCode', telemetry.postureCode);
    gardenService.recordTelemetry(telemetry).catch((error) => console.warn('Mock 乐园遥测结算失败', error));
    return telemetry;
  },

  applyOffline() {
    this.setData({
      postureCode: 'offline',
      posture: POSTURES.offline,
      deviceConnected: false,
      connectionText: '坐垫未连接',
      syncText: '正在尝试重新连接',
      batteryText: '--',
      balanceText: '暂无压力数据'
    });
  }
});
