const telemetryService = require('../../services/telemetry');
const reportService = require('../../services/reports');
const reportNotifications = require('../../services/reportNotifications');
const reportViewModel = require('../../services/reportViewModel');
const reportMarkdown = require('../../services/reportMarkdown');
const reportPdf = require('../../services/reportPdf');

Page({
  data: {
    report: null,
    loading: true,
    errorMessage: '',
    readWarning: '',
    isSystemReport: false,
    exporting: false
  },

  onLoad(options) {
    this.reportId = options.reportId || '';
    this.notificationId = options.notificationId || '';
    this.source = options.source || 'manual';
    this.initialIsRead = options.isRead === '1';
    const preview = wx.getStorageSync('reportDetailPreview');
    wx.removeStorageSync('reportDetailPreview');
    if (preview && String(preview.reportId) === String(this.reportId)) {
      this.setData({ report: preview, isSystemReport: preview.typeCode !== 'smart' });
    }
    return this.loadDetail();
  },

  loadDetail() {
    const student = wx.getStorageSync('currentStudent') || {};
    if (!this.reportId) {
      this.setData({ loading: false, errorMessage: '报告编号缺失，无法读取详情' });
      return Promise.resolve();
    }
    if (telemetryService.getTelemetryMode() !== '后端 API' || !student.student_id) {
      this.setData({ loading: false });
      if (!this.data.report) this.setData({ errorMessage: '当前模拟报告详情不存在，请返回后重试' });
      return Promise.resolve();
    }

    this.setData({ loading: true, errorMessage: '', readWarning: '' });
    return reportService.getReportDetail(student.student_id, this.reportId).then((raw) => {
      const isAutomatic = this.source === 'automatic';
      const notification = this.notificationId ? {
        notification_id: this.notificationId,
        related_report_id: raw.report_id,
        is_read: this.initialIsRead
      } : null;
      const report = reportViewModel.mapReport(raw, {
        notification,
        notificationId: this.notificationId,
        isRead: this.initialIsRead,
        sourceText: isAutomatic ? '自动生成' : (raw.report_type === 'smart' ? '手动生成' : '历史周期报告')
      });
      this.setData({ report, loading: false, isSystemReport: report.typeCode !== 'smart' });
      if (isAutomatic && this.notificationId && !this.initialIsRead) return this.markReadAfterDetail();
      return null;
    }).catch((error) => {
      console.error('读取报告详情失败', error);
      const message = `报告详情读取失败：${error.message}`;
      this.setData({ loading: false, errorMessage: message });
    });
  },

  markReadAfterDetail() {
    return reportNotifications.markReportNotificationRead(this.notificationId).then(() => {
      this.initialIsRead = true;
      this.setData({
        'report.isRead': true,
        'report.readText': '已读',
        readWarning: ''
      });
    }).catch((error) => {
      console.warn('报告已打开，但通知标记已读失败', error);
      this.setData({ readWarning: '报告详情已加载，但已读状态暂未同步；返回报告中心后可重试。' });
    });
  },

  copyAdvice() {
    const report = this.data.report;
    if (!report) return;
    const text = report.advicePlain || reportMarkdown.markdownToPlainText(report.advice);
    wx.setClipboardData({
      data: text,
      success: () => wx.showToast({ title: 'AI 建议已复制', icon: 'success' }),
      fail: () => wx.showToast({ title: '复制失败，请重试', icon: 'none' })
    });
  },

  exportPdf() {
    if (this.data.exporting || !this.data.report) return;
    this.setData({ exporting: true });
    wx.showLoading({ title: '正在生成 PDF', mask: true });
    reportPdf.exportReport(this, this.data.report).then((filePath) => {
      wx.hideLoading();
      this.setData({ exporting: false });
      wx.openDocument({
        filePath,
        fileType: 'pdf',
        showMenu: true,
        fail: (error) => wx.showModal({ title: 'PDF 已生成', content: `文档预览失败：${error.errMsg || '请稍后重试'}`, showCancel: false })
      });
    }).catch((error) => {
      wx.hideLoading();
      this.setData({ exporting: false });
      wx.showModal({ title: '导出失败', content: error.message || 'PDF 生成失败，请重试', showCancel: false });
    });
  }
});
