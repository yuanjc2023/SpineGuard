const telemetryService = require('../../services/telemetry');
const reportService = require('../../services/reports');
const reportNotifications = require('../../services/reportNotifications');
const reportViewModel = require('../../services/reportViewModel');

const SYSTEM_TYPES = ['daily', 'weekly', 'monthly'];

Page({
  data: {
    activeSection: 'smart',
    systemFilter: 'all',
    filterOptions: [
      { key: 'all', label: '全部' },
      { key: 'daily', label: '日报' },
      { key: 'weekly', label: '周报' },
      { key: 'monthly', label: '月报' }
    ],
    smartReports: [],
    systemReports: [],
    filteredSystemReports: [],
    unreadCount: 0,
    loading: false,
    generating: false,
    errorMessage: '',
    notificationWarning: ''
  },

  onShow() { this.loadReports(); },

  onPullDownRefresh() {
    this.loadReports().finally(() => wx.stopPullDownRefresh());
  },

  switchSection(e) {
    this.setData({ activeSection: e.currentTarget.dataset.section });
  },

  selectSystemFilter(e) {
    const systemFilter = e.currentTarget.dataset.filter;
    this.setData({ systemFilter }, () => this.applySystemFilter());
  },

  applySystemFilter() {
    const baseReports = this.data.systemFilter === 'all'
      ? this.data.systemReports
      : this.data.systemReports.filter((item) => item.typeCode === this.data.systemFilter);
    const groups = [
      { title: '未读报告', items: baseReports.filter((item) => item.readStateKnown && !item.isRead) },
      { title: '历史报告', items: baseReports.filter((item) => item.readStateKnown && item.isRead) },
      { title: '状态待同步', items: baseReports.filter((item) => !item.readStateKnown) }
    ];
    const filteredSystemReports = [];
    groups.forEach((group) => group.items.forEach((item, index) => {
      filteredSystemReports.push(Object.assign({}, item, { groupHeader: index === 0 ? group.title : '' }));
    }));
    this.setData({ filteredSystemReports });
  },

  loadReports() {
    const student = wx.getStorageSync('currentStudent') || {};
    if (telemetryService.getTelemetryMode() !== '后端 API' || !student.student_id) {
      const smartReports = [reportViewModel.mapReport(this.createMockSmartReport())];
      const systemReports = [reportViewModel.mapReport(this.createMockSystemReport(), {
        notification: { notification_id: 'NTF-MOCK', related_report_id: 'mock-weekly', is_read: false }
      })];
      this.setData({ smartReports, systemReports, unreadCount: 1, loading: false, errorMessage: '', notificationWarning: '' }, () => this.applySystemFilter());
      return Promise.resolve();
    }

    this.setData({ loading: true, errorMessage: '', notificationWarning: '' });
    const notificationsRequest = reportNotifications.listReportNotifications(student.student_id, false)
      .then((items) => ({ items, available: true }))
      .catch((error) => {
        console.warn('报告通知加载失败', error);
        return { items: [], available: false };
      });

    return Promise.all([reportService.listReports(student.student_id), notificationsRequest])
      .then(([rawReports, notificationResult]) => {
        const attached = reportNotifications.attachNotifications(rawReports, notificationResult.items);
        const reports = attached.map((raw) => reportViewModel.mapReport(raw, {
          notification: raw.reportNotification,
          readStateKnown: notificationResult.available,
          sourceText: raw.report_type === 'smart'
            ? '手动生成'
            : (raw.reportNotification ? '自动生成' : (notificationResult.available ? '历史周期报告' : '来源待同步'))
        }));
        const smartReports = reports.filter((item) => item.typeCode === 'smart').sort((left, right) => (
          Date.parse(right.createdAt || '') - Date.parse(left.createdAt || '')
        ));
        const systemReports = reports.filter((item) => SYSTEM_TYPES.includes(item.typeCode)).sort((left, right) => {
          if (left.isRead !== right.isRead) return left.isRead ? 1 : -1;
          return Date.parse(right.createdAt || '') - Date.parse(left.createdAt || '');
        });
        this.setData({
          smartReports,
          systemReports,
          unreadCount: notificationResult.items.filter((item) => !item.is_read).length,
          loading: false,
          notificationWarning: notificationResult.available ? '' : '系统报告已加载，但已读状态暂未同步'
        }, () => this.applySystemFilter());
      }).catch((error) => {
        console.error('加载后端报告失败', error);
        this.setData({ loading: false, errorMessage: `报告加载失败：${error.message}` });
      });
  },

  generateReport() {
    if (this.data.generating) return;
    const student = wx.getStorageSync('currentStudent') || {};
    if (telemetryService.getTelemetryMode() !== '后端 API' || !student.student_id) {
      const report = reportViewModel.mapReport(this.createMockSmartReport());
      this.setData({ smartReports: [report].concat(this.data.smartReports) });
      wx.showToast({ title: '模拟智能报告已生成', icon: 'none' });
      return;
    }
    this.setData({ generating: true, errorMessage: '' });
    reportService.generateSmartReport(student.student_id, 600).then((raw) => {
      const report = reportViewModel.mapReport(raw, { sourceText: '手动生成' });
      const smartReports = [report].concat(this.data.smartReports.filter((item) => item.reportId !== report.reportId));
      this.setData({ smartReports });
      wx.showToast({ title: '智能报告已生成', icon: 'success' });
    }).catch((error) => {
      const message = error.statusCode === 404 ? '当前学生暂无坐姿记录，无法生成智能报告' : `智能报告生成失败：${error.message}`;
      this.setData({ errorMessage: message });
      wx.showModal({ title: '生成失败', content: message, showCancel: false });
    }).finally(() => this.setData({ generating: false }));
  },

  openReport(e) {
    const id = e.currentTarget.dataset.id;
    const report = this.data.smartReports.concat(this.data.systemReports).find((item) => item.id === id);
    if (!report) return;
    wx.setStorageSync('reportDetailPreview', report);
    const params = [
      `reportId=${encodeURIComponent(report.reportId)}`,
      `source=${report.sourceText === '自动生成' ? 'automatic' : 'manual'}`,
      `isRead=${report.isRead ? '1' : '0'}`
    ];
    if (report.notificationId) params.push(`notificationId=${encodeURIComponent(report.notificationId)}`);
    wx.navigateTo({ url: `/pages/report-detail/report-detail?${params.join('&')}` });
  },

  createMockSmartReport() {
    const now = new Date();
    const date = this.dateText(now);
    return {
      report_id: `mock-smart-${Date.now()}`, report_type: 'smart', period_start: date, period_end: date,
      generated_by: 'rule', created_at: now.toISOString(), content: '最近坐姿数据显示标准坐姿占比正在改善。建议继续保持双脚平放，每 30 分钟起身活动。',
      summary: this.mockSummary()
    };
  },

  createMockSystemReport() {
    const now = new Date();
    return {
      report_id: 'mock-weekly', report_type: 'weekly', period_start: this.dateText(new Date(now.getTime() - 6 * 86400000)), period_end: this.dateText(now),
      generated_by: 'llm_fallback', created_at: now.toISOString(), content: '本周坐姿行为表现有所改善，请继续保持规律休息。',
      summary: Object.assign(this.mockSummary(), { risk: { risk_level: 'yellow', risk_score: 52 } })
    };
  },

  mockSummary() {
    return {
      record_count: 120, effective_sitting_s: 960, normal_sitting_s: 650, normal_ratio: .677, poor_sitting_s: 310,
      posture_stats: { normal:{duration_s:650,ratio:.677}, left_lean:{duration_s:90,ratio:.094}, right_lean:{duration_s:70,ratio:.073}, front_lean:{duration_s:110,ratio:.115}, back_lean:{duration_s:40,ratio:.041} },
      reminder_count:3, max_continuous_abnormal_s:42, avg_asymmetry_index:.0867,
      trend:{direction:'improving',description:'后半段非标准坐姿比例下降，姿态表现有所改善。',first_half_poor_ratio:.38,second_half_poor_ratio:.27}
    };
  },

  dateText(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }
});
