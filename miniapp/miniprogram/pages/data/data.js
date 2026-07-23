const telemetryService = require('../../services/telemetry');
const dataInsights = require('../../utils/dataInsights');

Page({
  data: {
    currentTab: 'week',
    loading: false,
    errorMessage: '',
    score: { score: 0, label: '等待今日数据', tone: 'waiting', changeText: '连接坐垫后开始分析', normalPercent: 0 },
    balance: { averagePercent: '0.0', level: '等待数据', levelTone: 'waiting', changeText: '暂无上一阶段数据', direction: 'stable', explanation: '数值越低，说明压力越均衡。' },
    composition: { items: [], normalPercent: 0, donutStyle: 'background:#e7eeea;', primaryIssue: '等待数据', primaryAdvice: '连接坐垫后开始分析。', effectiveCount: 0 },
    todayComposition: { items: [], normalPercent: 0, primaryIssue: '等待数据', primaryAdvice: '连接坐垫后开始分析。', effectiveCount: 0 },
    timeline: { segments: [], todayRecordCount: 0 },
    advice: { eyebrow: '今日坐姿观察', title: '等待数据', text: '连接坐垫后开始分析。' },
    trendValues: [],
    sampleCount: 0,
    todayCorrectText: '0 秒',
    longestPoorText: '0 秒',
    reminderCount: 0
  },

  onReady() {
    const query = wx.createSelectorQuery();
    query.select('#lineCanvas').fields({ node: true, size: true }).exec((result) => {
      const canvasInfo = result && result[0];
      if (!canvasInfo || !canvasInfo.node) return;
      const canvas = canvasInfo.node;
      const ctx = canvas.getContext('2d');
      const windowInfo = typeof wx.getWindowInfo === 'function' ? wx.getWindowInfo() : { pixelRatio: 1 };
      const dpr = Math.min(windowInfo.pixelRatio || 1, 2);
      canvas.width = Math.round(canvasInfo.width * dpr);
      canvas.height = Math.round(canvasInfo.height * dpr);
      ctx.scale(dpr, dpr);
      this.lineChartCtx = ctx;
      this.lineChartSize = { width: canvasInfo.width, height: canvasInfo.height };
      this.drawLineChart();
    });
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) this.getTabBar().setData({ selected: 1 });
    this.loadBackendData();
  },

  onPullDownRefresh() {
    this.loadBackendData().finally(() => wx.stopPullDownRefresh());
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab;
    if (tab === this.data.currentTab || this.data.loading) return;
    this.setData({ currentTab: tab }, () => this.loadBackendData());
  },

  navigateToAi() {
    wx.navigateTo({ url: '/pages/ai-sports/ai-sports' });
  },

  loadBackendData() {
    const requestToken = Date.now();
    this.requestToken = requestToken;
    this.setData({ loading: true, errorMessage: '' });
    const now = new Date();

    if (telemetryService.getTelemetryMode() === 'Mock') {
      const mock = this.createMockData(now);
      const dashboard = dataInsights.buildDashboard(Object.assign({ tab: this.data.currentTab, now }, mock));
      this.applyDashboard(dashboard, requestToken);
      return Promise.resolve();
    }

    const date = this.formatDate(now);
    const week = this.formatIsoWeek(now);
    const boundDevice = wx.getStorageSync('boundDevice') || {};
    const range = this.periodRange(this.data.currentTab, now);
    const weeklyRequest = this.data.currentTab === 'week'
      ? telemetryService.getWeeklyStat(week)
      : Promise.resolve(null);
    const previousDailyRequest = this.data.currentTab === 'week'
      ? Promise.resolve(null)
      : telemetryService.getDailyStat(this.formatDate(new Date(now.getTime() - 86400000))).catch(() => null);
    const previousWeeklyRequest = this.data.currentTab === 'week'
      ? telemetryService.getWeeklyStat(this.formatIsoWeek(new Date(now.getTime() - 7 * 86400000))).catch(() => null)
      : Promise.resolve(null);

    return Promise.all([
      telemetryService.getDailyStat(date),
      weeklyRequest,
      previousDailyRequest,
      previousWeeklyRequest,
      telemetryService.getTelemetryHistory(
        boundDevice.deviceCode || telemetryService.defaultDeviceId,
        2000,
        { from: String(range.from), to: String(range.to) }
      )
    ]).then(([daily, weekly, previousDaily, previousWeekly, history]) => {
      const dashboard = dataInsights.buildDashboard({
        daily, weekly, previousWeekly, history, tab: this.data.currentTab, now,
        previousNormalRatio: previousDaily && Number(previousDaily.total_sitting_s || 0) > 0
          ? Number(previousDaily.normal_ratio || 0)
          : undefined
      });
      this.applyDashboard(dashboard, requestToken);
    }).catch((error) => {
      if (this.requestToken !== requestToken) return;
      console.error('获取后端统计失败', error);
      const emptyDashboard = dataInsights.buildDashboard({ history: [], tab: this.data.currentTab, now });
      this.setData(Object.assign({}, emptyDashboard, {
        loading: false,
        errorMessage: `后端数据读取失败：${error.message}`
      }), () => this.drawLineChart());
    });
  },

  applyDashboard(dashboard, requestToken) {
    if (this.requestToken !== requestToken) return;
    this.setData(Object.assign({}, dashboard, { loading: false, errorMessage: '' }), () => this.drawLineChart());
  },

  periodRange(tab, now) {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    if (tab === 'week') {
      const weekday = start.getDay() || 7;
      start.setDate(start.getDate() - weekday + 1);
    } else if (tab === 'month') {
      start.setDate(1);
    } else if (tab === 'year') {
      start.setMonth(0, 1);
    }
    return { from: start.getTime(), to: now.getTime() };
  },

  formatDate(date) {
    return dataInsights.localDateText(date);
  },

  formatIsoWeek(date) {
    const value = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const day = value.getUTCDay() || 7;
    value.setUTCDate(value.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(value.getUTCFullYear(), 0, 1));
    const week = Math.ceil((((value - yearStart) / 86400000) + 1) / 7);
    return `${value.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
  },

  createMockData(now) {
    const history = [];
    const postures = ['normal', 'normal', 'normal', 'normal', 'front_lean', 'normal', 'left_lean', 'normal', 'right_lean', 'normal'];
    for (let index = 0; index < 300; index += 1) {
      const recordedAt = new Date(now);
      recordedAt.setHours(8, index * 2, 0, 0);
      const postureCode = postures[index % postures.length];
      const asymmetry = postureCode === 'normal' ? 0.07 + (index % 4) * 0.01 : 0.18 + (index % 5) * 0.02;
      history.push({
        recordedAt: recordedAt.getTime(), postureCode,
        asymmetryPercent: Math.round(asymmetry * 100),
        pressureFeatures: { asymmetryIndex: asymmetry },
        postureDurationSeconds: (index % 8 + 1) * 2
      });
    }
    const dailyItems = [];
    for (let offset = 6; offset >= 0; offset -= 1) {
      const date = new Date(now.getTime() - offset * 86400000);
      dailyItems.push({
        date: this.formatDate(date), total_sitting_s: 5400,
        normal_sitting_s: Math.round(5400 * (0.7 + (6 - offset) * 0.015)),
        normal_ratio: 0.7 + (6 - offset) * 0.015,
        avg_asymmetry_index: 0.14 - (6 - offset) * 0.007,
        reminder_count: Math.max(1, 6 - (6 - offset))
      });
    }
    return {
      daily: {
        total_sitting_s: 5400, normal_sitting_s: 4212, poor_sitting_s: 1188,
        normal_ratio: 0.78, reminder_count: 2, avg_asymmetry_index: 0.098,
        max_poor_posture_duration_s: 72
      },
      weekly: {
        total_sitting_s: 37800, normal_ratio: 0.75, avg_asymmetry_index: 0.112,
        daily_items: dailyItems
      },
      previousWeekly: { total_sitting_s: 34200, avg_asymmetry_index: 0.143 },
      history
    };
  },

  drawLineChart() {
    if (!this.lineChartCtx || !this.lineChartSize) return;
    this.paintLineChart(this.lineChartSize.width, this.lineChartSize.height);
  },

  paintLineChart(width, height) {
    const ctx = this.lineChartCtx;
    const values = this.data.trendValues || [];
    const validValues = values.filter((value) => value !== null && value !== undefined && !Number.isNaN(Number(value)));
    const observedMax = validValues.length ? Math.max.apply(null, validValues.map(Number)) : 0;
    const maxValue = Math.min(1, Math.max(0.3, Math.ceil((observedMax + 0.05) * 10) / 10));
    const padding = { top: 18, right: 12, bottom: 34, left: 44 };
    const plotWidth = Math.max(1, width - padding.left - padding.right);
    const plotHeight = Math.max(1, height - padding.top - padding.bottom);
    ctx.clearRect(0, 0, width, height);

    const goodY = padding.top + plotHeight * (1 - 0.15 / maxValue);
    ctx.fillStyle = 'rgba(54, 201, 130, 0.10)';
    ctx.fillRect(padding.left, goodY, plotWidth, padding.top + plotHeight - goodY);
    ctx.strokeStyle = '#e5ece8';
    ctx.lineWidth = 1;
    const gridValues = [0, 0.15, maxValue / 2, maxValue]
      .filter((value, index, list) => list.findIndex((item) => Math.abs(item - value) < 0.001) === index)
      .sort((left, right) => left - right);
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    gridValues.forEach((value) => {
      const y = padding.top + plotHeight * (1 - value / maxValue);
      ctx.beginPath(); ctx.moveTo(padding.left, y); ctx.lineTo(width - padding.right, y); ctx.stroke();
      ctx.fillStyle = value === 0.15 ? '#4a9870' : '#99a69f';
      ctx.fillText(`${Math.round(value * 100)}%`, padding.left - 7, y);
    });

    const rangeLabels = {
      day: ['清晨', '中午', '现在'],
      week: ['周一', '周中', '今日'],
      month: ['月初', '月中', '今日'],
      year: ['年初', '年中', '本月']
    }[this.data.currentTab] || ['开始', '中间', '现在'];
    ctx.fillStyle = '#99a69f';
    ctx.font = '10px sans-serif';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillText(rangeLabels[0], padding.left, height - 22);
    ctx.textAlign = 'center';
    ctx.fillText(rangeLabels[1], padding.left + plotWidth / 2, height - 22);
    ctx.textAlign = 'right';
    ctx.fillText(rangeLabels[2], width - padding.right, height - 22);

    if (!values.length) {
      ctx.fillStyle = '#9ba8a0';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('当前周期暂无压力趋势数据', padding.left + plotWidth / 2, padding.top + plotHeight / 2);
      return;
    }
    const step = values.length > 1 ? plotWidth / (values.length - 1) : plotWidth;
    let drawing = false;
    ctx.beginPath();
    values.forEach((value, index) => {
      if (value === null || value === undefined) { drawing = false; return; }
      const x = padding.left + (values.length > 1 ? index * step : plotWidth / 2);
      const y = padding.top + plotHeight * (1 - clampChartValue(value, maxValue) / maxValue);
      if (!drawing) { ctx.moveTo(x, y); drawing = true; } else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = '#2f9f77';
    ctx.lineWidth = 3.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();

    values.forEach((value, index) => {
      if (value === null || value === undefined) return;
      const x = padding.left + (values.length > 1 ? index * step : plotWidth / 2);
      const y = padding.top + plotHeight * (1 - clampChartValue(value, maxValue) / maxValue);
      ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = '#2f9f77'; ctx.stroke();
    });
  }
});

function clampChartValue(value, maxValue) {
  return Math.max(0, Math.min(maxValue, Number(value) || 0));
}
