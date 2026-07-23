const api = require('./api');
const telemetryService = require('./telemetry');

let latestReport = null;
let latestReportKey = '';

function cloudAvailable() {
  return Boolean(wx.cloud && typeof wx.cloud.callFunction === 'function');
}

function callCloudAi(type, data) {
  if (!cloudAvailable()) return Promise.reject(new Error('当前基础库不支持云函数'));
  return wx.cloud.callFunction({
    name: 'quickstartFunctions',
    data: Object.assign({ type }, data || {})
  }).then((res) => {
    const result = res && res.result;
    if (!result || result.success === false) {
      throw new Error((result && result.errMsg) || '云函数 AI 调用失败');
    }
    return result;
  });
}

function summarizeHistory(history) {
  const counts = {};
  let totalAsymmetry = 0;
  (history || []).forEach((item) => {
    counts[item.postureCode] = (counts[item.postureCode] || 0) + 1;
    totalAsymmetry += Number(item.pressureFeatures ? item.pressureFeatures.asymmetryIndex : item.asymmetryPercent / 100) || 0;
  });
  const total = history && history.length ? history.length : 0;
  return {
    sample_count: total,
    posture_counts: counts,
    avg_asymmetry_index: total ? Number((totalAsymmetry / total).toFixed(3)) : 0
  };
}

function loadPostureContext(date) {
  if (telemetryService.getTelemetryMode() === 'Mock') {
    return Promise.resolve({ daily_stat: null, history_summary: null });
  }
  const boundDevice = wx.getStorageSync('boundDevice') || {};
  const deviceId = boundDevice.deviceCode || telemetryService.defaultDeviceId;
  return Promise.all([
    telemetryService.getDailyStat(date).catch(() => null),
    telemetryService.getTelemetryHistory(deviceId, 200).then(summarizeHistory).catch(() => null)
  ]).then(([dailyStat, historySummary]) => ({
    daily_stat: dailyStat,
    history_summary: historySummary
  }));
}

function generateDailyReport(studentId, date) {
  const key = `${studentId}:${date}`;
  // 正式模式以 SpineGuard 报告接口为主；云函数只在后端报告请求失败时兜底。
  return api.request({
      path: `/students/${encodeURIComponent(studentId)}/reports/generate`,
      method: 'POST',
      data: { report_type: 'daily', use_llm: true, date },
      timeout: 35000
    }).then((payload) => payload.data)
    .catch((backendError) => {
      if ([401, 403, 422].includes(backendError.statusCode)) throw backendError;
      return loadPostureContext(date)
        .then((context) => callCloudAi('generateDailyPostureReport', { studentId, date, context }))
        .then((result) => result.report)
        .catch(() => { throw backendError; });
    })
    .then((report) => {
      latestReport = report;
      latestReportKey = key;
      return latestReport;
    });
}

function answerFromReport(message, report) {
  const summary = report && report.summary ? report.summary : {};
  const risk = summary.risk || {};
  const normal = Number(summary.normal_sitting_s || 0);
  const poor = Number(summary.poor_sitting_s || 0);
  const total = Number(summary.total_sitting_s || normal + poor);
  const normalPercent = total > 0 ? Math.round(normal / total * 100) : 0;
  const reminderCount = Number(summary.reminder_count || 0);
  const asymmetry = Number(summary.avg_asymmetry_index || 0);
  const question = String(message || '');

  if (!total) {
    return '今天暂时没有足够的坐姿数据。请确认坐垫已绑定并持续上传一段时间后再来查看。';
  }
  if (/压力|均衡|左右|重心|对称/.test(question)) {
    const level = asymmetry < 0.15 ? '整体较均衡' : asymmetry < 0.3 ? '存在轻微不均衡' : '不均衡较明显';
    return `今天的平均压力不对称指数为 ${asymmetry.toFixed(2)}，${level}。建议双脚平放、臀部坐在坐垫中央，并观察调整后数值是否下降。`;
  }
  if (/提醒|纠正|异常/.test(question)) {
    return `今天记录到 ${reminderCount} 次坐姿提醒，非标准坐姿约 ${Math.round(poor / 60)} 分钟。${risk.suggestion || '建议减少连续久坐，并在提醒后及时回到自然坐姿。'}`;
  }
  if (/放松|运动|休息|建议|肩|颈|腰/.test(question)) {
    return `${risk.suggestion || '建议每学习 40～60 分钟起身活动。'} 可以先做 1～2 分钟肩颈放松、扩胸运动和远眺；如持续不适，应及时咨询专业人员。`;
  }
  if (/今天|坐姿|表现|怎么样|总结/.test(question)) {
    return `今天标准坐姿占比约 ${normalPercent}%，非标准坐姿约 ${Math.round(poor / 60)} 分钟，共提醒 ${reminderCount} 次。${risk.suggestion || '继续保持双脚平放，并定时起身活动。'}`;
  }
  return report.content || `今天标准坐姿占比约 ${normalPercent}%，提醒 ${reminderCount} 次。你也可以继续问我压力分布、提醒次数或放松建议。`;
}

function chat(studentId, message, date, history) {
  const key = `${studentId}:${date}`;
  const reportPromise = latestReport && latestReportKey === key
    ? Promise.resolve(latestReport)
    : generateDailyReport(studentId, date);
  return loadPostureContext(date)
    .then((context) => callCloudAi('assistantChat', {
      studentId,
      message,
      date,
      history: (history || []).slice(-8).map((item) => ({ role: item.role, content: item.text || item.content })),
      context,
      report: latestReportKey === key ? latestReport : null
    }))
    .then((result) => result.data)
    .catch(() => reportPromise.then((report) => ({
      reply: answerFromReport(message, report),
      generated_by: report.generated_by === 'llm' ? 'llm_report' : 'rule'
    })));
}

module.exports = { generateDailyReport, chat };
