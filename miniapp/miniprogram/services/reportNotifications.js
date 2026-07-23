const api = require('./api');

function listReportNotifications(studentId, unreadOnly) {
  if (!studentId) return Promise.resolve([]);
  return api.request({
    path: '/notifications',
    data: unreadOnly ? { unread_only: true } : undefined
  }).then((payload) => (payload.items || []).filter((item) => (
    item.notification_type === 'report' && item.student_id === studentId
  )));
}

function getUnreadReportCount(studentId) {
  return listReportNotifications(studentId, true).then((items) => items.length);
}

function markReportNotificationRead(notificationId) {
  if (!notificationId) return Promise.resolve(null);
  return api.request({
    path: `/notifications/${encodeURIComponent(notificationId)}/read`,
    method: 'POST'
  }).then((payload) => payload.data || null);
}

function attachNotifications(reports, notifications) {
  const notificationsByReportId = {};
  (notifications || []).forEach((notification) => {
    if (notification.related_report_id === undefined || notification.related_report_id === null) return;
    notificationsByReportId[String(notification.related_report_id)] = notification;
  });
  return (reports || []).map((report) => Object.assign({}, report, {
    reportNotification: notificationsByReportId[String(report.report_id)] || null
  }));
}

module.exports = {
  listReportNotifications,
  getUnreadReportCount,
  markReportNotificationRead,
  attachNotifications
};
