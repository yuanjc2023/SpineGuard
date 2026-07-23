const reportMarkdown = require('./reportMarkdown');

const POSTURE_META = {
  normal: '标准坐姿',
  left_lean: '左倾',
  right_lean: '右倾',
  front_lean: '前倾',
  back_lean: '后倾'
};
const REPORT_TYPE_META = { smart: '智能报告', daily: '日报', weekly: '周报', monthly: '月报' };
const TREND_META = {
  improving: { label: '有所改善', className: 'improving' },
  worsening: { label: '需要关注', className: 'worsening' },
  stable: { label: '基本稳定', className: 'stable' },
  insufficient_data: { label: '数据不足', className: 'insufficient' }
};

function clampRatio(value) { return Math.max(0, Math.min(1, Number(value) || 0)); }
function percent(value) { return Math.round(clampRatio(value) * 100); }

function formatDuration(seconds) {
  const safe = Math.max(0, Math.round(Number(seconds) || 0));
  if (safe < 60) return `${safe} 秒`;
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const restSeconds = safe % 60;
  if (hours) return `${hours} 小时${minutes ? ` ${minutes} 分` : ''}`;
  return `${minutes} 分${restSeconds ? ` ${restSeconds} 秒` : ''}`;
}

function formatDateTime(value) {
  if (!value) return '暂无';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function buildPostureBreakdown(summary) {
  const postureStats = summary.posture_stats || {};
  const hasDetailedStats = Object.keys(POSTURE_META).some((key) => postureStats[key]);
  if (hasDetailedStats) {
    return Object.keys(POSTURE_META).map((key) => {
      const item = postureStats[key] || {};
      const itemPercent = percent(item.ratio);
      return { key, name: POSTURE_META[key], percent: itemPercent, barWidth: itemPercent, durationText: formatDuration(item.duration_s), normal: key === 'normal' };
    });
  }
  const total = Number(summary.normal_sitting_s || 0) + Number(summary.poor_sitting_s || 0);
  const normalRatio = summary.normal_ratio !== undefined ? clampRatio(summary.normal_ratio) : (total ? Number(summary.normal_sitting_s || 0) / total : 0);
  const normalPercent = percent(normalRatio);
  return [
    { key: 'normal', name: '标准坐姿', percent: normalPercent, barWidth: normalPercent, durationText: formatDuration(summary.normal_sitting_s), normal: true },
    { key: 'poor', name: '非标准坐姿', percent: 100 - normalPercent, barWidth: 100 - normalPercent, durationText: formatDuration(summary.poor_sitting_s), normal: false }
  ];
}

function mapReport(report, options) {
  const opts = options || {};
  const summary = report.summary || {};
  const risk = summary.risk || null;
  const riskLevel = risk ? ({ green: 'low', yellow: 'medium', red: 'high' }[risk.risk_level] || 'reference') : 'reference';
  const riskText = risk ? ({ green: '低风险', yellow: '中风险', red: '高风险' }[risk.risk_level] || '筛查参考') : '筛查参考';
  const normalRatio = summary.normal_ratio !== undefined ? clampRatio(summary.normal_ratio) : (Number(summary.effective_sitting_s || 0) ? Number(summary.normal_sitting_s || 0) / Number(summary.effective_sitting_s) : 0);
  const trend = summary.trend || {};
  const trendMeta = TREND_META[trend.direction] || TREND_META.insufficient_data;
  const notification = opts.notification || report.reportNotification || null;
  const reportId = report.report_id !== undefined ? report.report_id : `mock-${report.created_at || Date.now()}`;
  const isSmartReport = report.report_type === 'smart';
  const sourceText = opts.sourceText || (isSmartReport ? '手动生成' : (notification ? '自动生成' : '历史周期报告'));
  const generatedBy = report.generated_by || 'rule';
  const peak = summary.reminder_peak_day;
  const periodText = report.period_start === report.period_end ? (report.period_end || '日期未知') : `${report.period_start || '?'} 至 ${report.period_end || '?'}`;
  const isRead = opts.isRead !== undefined ? Boolean(opts.isRead) : (notification ? Boolean(notification.is_read) : true);
  const readStateKnown = isSmartReport || Boolean(notification) || opts.readStateKnown !== false;
  const advice = report.content || (risk && risk.suggestion) || '暂无报告建议';
  return {
    id: `report-${reportId}`,
    reportId,
    notificationId: notification ? notification.notification_id : (opts.notificationId || ''),
    relatedReportId: notification && notification.related_report_id !== undefined ? notification.related_report_id : reportId,
    notification,
    isRead,
    readStateKnown,
    readText: readStateKnown ? (isRead ? '已读' : '未读') : '状态待同步',
    sourceText,
    typeCode: report.report_type || 'unknown',
    type: REPORT_TYPE_META[report.report_type] || '坐姿报告',
    date: report.period_end || (report.created_at || '').slice(0, 10),
    periodText,
    createdAt: report.created_at || '',
    createdAtText: formatDateTime(report.created_at),
    dataRangeText: summary.data_start_at && summary.data_end_at ? `${formatDateTime(summary.data_start_at)} 至 ${formatDateTime(summary.data_end_at)}` : periodText,
    recordCount: Number(summary.record_count || 0),
    effectiveTimeText: formatDuration(summary.effective_sitting_s !== undefined ? summary.effective_sitting_s : summary.total_sitting_s),
    normalTimeText: formatDuration(summary.normal_sitting_s),
    poorTimeText: formatDuration(summary.poor_sitting_s),
    normalPercent: percent(normalRatio),
    reminderCount: Number(summary.reminder_count || 0),
    reminderPeakText: peak ? `${peak.date} · ${peak.count} 次` : '暂无',
    longestAbnormalText: formatDuration(summary.max_continuous_abnormal_s),
    pai: Number(summary.avg_asymmetry_index || 0).toFixed(4),
    postureBreakdown: buildPostureBreakdown(summary),
    trendText: trend.description || '有效数据不足，暂无法判断姿态变化趋势。',
    trendLabel: trendMeta.label,
    trendClass: trendMeta.className,
    firstHalfPercent: trend.first_half_poor_ratio === null || trend.first_half_poor_ratio === undefined ? '--' : `${percent(trend.first_half_poor_ratio)}%`,
    secondHalfPercent: trend.second_half_poor_ratio === null || trend.second_half_poor_ratio === undefined ? '--' : `${percent(trend.second_half_poor_ratio)}%`,
    riskLevel,
    riskText,
    riskScore: risk && risk.risk_score !== undefined ? risk.risk_score : null,
    generatedBy,
    generatedText: generatedBy === 'llm' ? 'AI 智能生成' : (generatedBy === 'llm_fallback' ? '规则兜底' : '规则生成'),
    isFallback: generatedBy === 'llm_fallback',
    advice,
    adviceHtml: reportMarkdown.markdownToRichText(advice),
    advicePlain: reportMarkdown.markdownToPlainText(advice),
    summary
  };
}

module.exports = { mapReport, formatDuration, formatDateTime };
