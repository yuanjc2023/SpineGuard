const telemetryService = require('../../services/telemetry');
const gardenService = require('../../services/garden');

const LEGACY_STORAGE_KEY = 'spineTreeGardenState';
const STAGES = [
  { key: 'seed', name: '种子期', min: 0, next: 100, icon: '🌰', description: '种子正在土壤中积蓄力量' },
  { key: 'sprout', name: '幼苗期', min: 100, next: 300, icon: '🌱', description: '嫩芽破土，长出第一对叶片' },
  { key: 'sapling', name: '小树期', min: 300, next: 600, icon: '🌿', description: '树干成形，枝叶逐渐舒展' },
  { key: 'tree', name: '大树期', min: 600, next: 1000, icon: '🌳', description: '树冠茂盛，主干更加挺拔' },
  { key: 'flower', name: '开花期', min: 1000, next: 1500, icon: '🌸', description: '枝头绽放花朵，等待结果' },
  { key: 'fruit', name: '结果期', min: 1500, next: Infinity, icon: '🍎', description: '果实成熟，记录长期坚持' }
];
const POSTURES = {
  normal: { name: '标准坐姿', icon: '✨', treeClass: 'normal', message: '小树挺拔舒展，继续保持。' },
  left_lean: { name: '左侧倾斜', icon: '↙️', treeClass: 'left-lean', message: '身体向左倾斜，轻轻回到坐垫中央。' },
  right_lean: { name: '右侧倾斜', icon: '↘️', treeClass: 'right-lean', message: '身体向右倾斜，轻轻回到坐垫中央。' },
  front_lean: { name: '身体前倾', icon: '🥀', treeClass: 'front-lean', message: '抬头放松肩膀，让小树重新挺拔。' },
  back_lean: { name: '身体后倾', icon: '🌧️', treeClass: 'back-lean', message: '双脚放稳，回到自然坐姿。' },
  empty: { name: '暂时离座', icon: '🪑', treeClass: 'empty', message: '小树正在等你回来，本地专注计时不受影响。' },
  unknown: { name: '暂时无法识别', icon: '❔', treeClass: 'unknown', message: '保持自然坐姿，当前不计为异常。' },
  offline: { name: '设备离线', icon: '📴', treeClass: 'offline', message: '连接中断，坐姿数据暂不可用；本地专注计时不受影响。' }
};

function emptyGarden() {
  return { growth: 0, stage: 'seed', resources: { sunshine: 0, water: 0, nutrient: 0 }, todayNormalSeconds: 0, continuousNormalSeconds: 0, reminderCount: 0, reminderRate30m: 0, instantTreeState: 'unknown', recoveryNeeded: false, tasks: [], ruleVersion: 'waiting', updatedAt: '' };
}
function rewardText(reward) {
  return [['☀️', reward.sunshine], ['💧', reward.water], ['🌱', reward.nutrient]].filter((item) => item[1] > 0).map((item) => `${item[0]} +${item[1]}`).join('  ');
}

Page({
  data: {
    growth: 0, sunshine: 0, water: 0, nutrition: 0,
    postureCode: 'unknown', posture: POSTURES.unknown,
    severityClass: '', recoveryNeeded: false, canRecover: false,
    stage: STAGES[0], stageProgress: 0, nextStageText: '等待乐园数据',
    tasks: [], correctMinutes: 0, continuousMinutes: 0, reminderCount: 0,
    focus: null, focusStatusText: '尚未开始', focusSettlementText: '',
    isMockMode: gardenService.getMode() === 'mock', quickTestEnabled: gardenService.quickEnabled(),
    backendAvailable: true, errorMessage: '', busyAction: '', ruleVersion: '',
    postureOptions: [
      { key: 'normal', label: '标准' }, { key: 'left_lean', label: '左倾' }, { key: 'right_lean', label: '右倾' },
      { key: 'front_lean', label: '前倾' }, { key: 'back_lean', label: '后倾' }, { key: 'empty', label: '离座' }, { key: 'unknown', label: '未知' }
    ],
    focusTargets: [15, 30, 45, 60],
    stageOptions: STAGES.map((item) => ({ key: item.key, label: item.name }))
  },

  onLoad() {
    // v1 缓存包含旧奖励字段，整体丢弃，避免被新页面继续读取。
    wx.removeStorageSync(LEGACY_STORAGE_KEY);
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) this.getTabBar().setData({ selected: 2 });
    this.setData({ isMockMode: gardenService.getMode() === 'mock', quickTestEnabled: gardenService.quickEnabled() });
    this.syncAll();
    if (this.gameSocket) this.gameSocket.close();
    this.gameSocket = gardenService.subscribeGame({ onEvent: () => this.syncAll(), onError: (error) => console.warn('游戏状态推送失败', error) });
    clearInterval(this.focusSyncTimer);
    this.focusSyncTimer = setInterval(() => {
      gardenService.currentFocus().then((focus) => this.applyFocus(focus)).catch(() => {});
    }, 1000);
  },

  onHide() { clearInterval(this.focusSyncTimer); this.focusSyncTimer = null; if (this.gameSocket) this.gameSocket.close(); this.gameSocket = null; },
  onUnload() { clearInterval(this.focusSyncTimer); this.focusSyncTimer = null; if (this.gameSocket) this.gameSocket.close(); this.gameSocket = null; },

  syncAll() {
    const boundDevice = wx.getStorageSync('boundDevice') || {};
    const deviceId = boundDevice.deviceCode || telemetryService.defaultDeviceId;
    Promise.all([gardenService.getGarden(), gardenService.currentFocus()])
      .then(([garden, focus]) => {
        this.applyGarden(garden);
        this.applyFocus(focus);
        this.setData({ backendAvailable: true, errorMessage: '' });
        telemetryService.getLatestTelemetry(deviceId)
          .then((telemetry) => this.applyPosture(telemetry.postureCode, false))
          .catch(() => this.applyPosture(garden.deviceOnline ? 'unknown' : 'offline', false));
      })
      .catch((error) => {
        console.error('乐园同步失败', error);
        this.setData({ backendAvailable: gardenService.getMode() === 'mock', errorMessage: gardenService.getMode() === 'api' ? `乐园数据同步失败：${error.message}` : error.message });
        telemetryService.getLatestTelemetry(deviceId).then((telemetry) => this.applyPosture(telemetry.postureCode, false)).catch(() => {});
      });
  },

  applyGarden(garden) {
    const vm = garden || emptyGarden();
    const stageIndex = Math.max(0, STAGES.findIndex((item) => item.key === vm.stage));
    const stage = STAGES[stageIndex];
    const finalStage = stageIndex === STAGES.length - 1;
    const stageProgress = finalStage ? 100 : Math.max(0, Math.min(100, Math.round((vm.growth - stage.min) / (stage.next - stage.min) * 100)));
    const tasks = vm.tasks.map((task) => ({
      id: task.taskId, title: task.title, progress: task.progress, target: task.target, unit: task.unit,
      status: task.status, statusText: { locked: '未达成', claimable: '可领取', claimed: '已领取' }[task.status],
      rewardText: rewardText(task.reward), canClaim: task.status === 'claimable'
    }));
    const treeParts = String(vm.instantTreeState || '').split(':');
    const treeCode = POSTURES[treeParts[0]] ? treeParts[0] : (treeParts[0] === 'offline' ? 'offline' : this.data.postureCode);
    const severityClass = treeParts.indexOf('severe') >= 0 ? 'severity-severe' : treeParts.indexOf('warning') >= 0 ? 'severity-warning' : treeParts.indexOf('mild') >= 0 ? 'severity-mild' : '';
    this.setData({
      growth: vm.growth, sunshine: vm.resources.sunshine, water: vm.resources.water, nutrition: vm.resources.nutrient,
      stage, stageProgress, nextStageText: finalStage ? '已解锁最高成长阶段' : `距离${STAGES[stageIndex + 1].name}还需要 ${stage.next - vm.growth} 成长值`,
      tasks, correctMinutes: Math.floor(vm.todayNormalSeconds / 60), continuousMinutes: Math.floor(vm.continuousNormalSeconds / 60),
      reminderCount: vm.reminderCount, reminderRate30m: vm.reminderRate30m, ruleVersion: vm.ruleVersion,
      severityClass, recoveryNeeded: vm.recoveryNeeded, canRecover: vm.recoveryNeeded && treeCode === 'normal'
    });
    if (treeCode && (treeParts.length > 1 || treeCode === 'offline')) this.applyPosture(treeCode, false);
  },

  applyPosture(code, showToast) {
    const posture = POSTURES[code] || POSTURES.unknown;
    this.setData({ postureCode: POSTURES[code] ? code : 'unknown', posture });
    if (showToast) wx.showToast({ title: posture.name, icon: 'none' });
  },

  applyFocus(focus) {
    if (!focus) {
      this.setData({ focus: null, focusStatusText: '尚未开始', focusSettlementText: '' });
      return;
    }
    const statusText = {
      running: '专注进行中',
      paused: '已手动暂停',
      completed: '本轮已完成',
      cancelled: '本轮已结束'
    }[focus.status] || '专注计时';
    this.setData({
      focus,
      focusStatusText: `${statusText} · 已计时 ${this.formatFocusTime(focus.elapsedSeconds)} · 剩余 ${this.formatFocusTime(focus.remainingSeconds)}`,
      focusSettlementText: '本地计时，不产生奖励或惩罚'
    });
  },

  formatFocusTime(seconds) {
    const safe = Math.max(0, Math.floor(Number(seconds) || 0));
    return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
  },

  useResource(e) {
    if (!this.data.backendAvailable || this.data.busyAction) return;
    const aliases = { sunshine: 'sunbathe', water: 'water', nutrition: 'fertilize', recover_tree: 'recover_tree' };
    const action = aliases[e.currentTarget.dataset.action];
    this.setData({ busyAction: action });
    gardenService.useResource(action).then((garden) => {
      this.applyGarden(garden);
      wx.showToast({ title: '余额已按服务端结果刷新', icon: 'none' });
    }).catch((error) => { if (error.statusCode === 409) this.syncAll(); wx.showToast({ title: error.message, icon: 'none' }); })
      .finally(() => this.setData({ busyAction: '' }));
  },

  claimTask(e) {
    if (!this.data.backendAvailable || this.data.busyAction) return;
    this.setData({ busyAction: `task:${e.currentTarget.dataset.id}` });
    gardenService.claimTask(e.currentTarget.dataset.id).then((garden) => {
      this.applyGarden(garden); wx.showToast({ title: '奖励已领取', icon: 'none' });
    }).catch((error) => { if (error.statusCode === 409) this.syncAll(); wx.showToast({ title: error.message, icon: 'none' }); })
      .finally(() => this.setData({ busyAction: '' }));
  },

  startFocus(e) {
    if (this.data.busyAction) return;
    const target = Number(e && e.currentTarget && e.currentTarget.dataset.minutes) || 15;
    wx.navigateTo({ url: `/pages/focus/focus?minutes=${target}` });
  },

  openFocus() {
    if (!this.data.focus || this.data.busyAction) return;
    wx.navigateTo({ url: '/pages/focus/focus' });
  },

  goToAiAssistant() {
    wx.navigateTo({ url: '/pages/ai-sports/ai-sports' });
  },

  selectPosture(e) { this.applyPosture(e.currentTarget.dataset.key, true); },

  runQuickScenario(e) {
    gardenService.quickScenario(e.currentTarget.dataset.scenario).then((result) => {
      if (result && result.growth !== undefined) this.applyGarden(result);
      else {
        this.applyFocus(result);
        gardenService.getGarden().then((garden) => this.applyGarden(garden));
      }
      wx.showToast({ title: '测试场景已切换', icon: 'none' });
    }).catch((error) => wx.showToast({ title: error.message, icon: 'none' }));
  }
});
