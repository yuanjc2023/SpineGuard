const api = require('./api');

function studentPath(studentId, suffix) {
  if (!studentId) throw new Error('请先登录并选择学生');
  return `/students/${encodeURIComponent(studentId)}/reports${suffix || ''}`;
}

function listReports(studentId) {
  return api.request({ path: studentPath(studentId) })
    .then((payload) => payload.items || []);
}

function getReportDetail(studentId, reportId) {
  if (reportId === undefined || reportId === null || reportId === '') {
    return Promise.reject(new Error('报告编号缺失'));
  }
  return api.request({
    path: studentPath(studentId, `/${encodeURIComponent(reportId)}`)
  }).then((payload) => payload.data);
}

function generateSmartReport(studentId, recordLimit = 600) {
  const safeLimit = Math.max(1, Math.min(1000, Number(recordLimit) || 600));
  return api.request({
    path: studentPath(studentId, '/generate'),
    method: 'POST',
    data: { report_type: 'smart', record_limit: safeLimit },
    timeout: 60000
  }).then((payload) => payload.data);
}

module.exports = { listReports, getReportDetail, generateSmartReport };
