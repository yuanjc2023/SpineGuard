const EFFECTIVE_POSTURES = ['normal', 'left_lean', 'right_lean', 'front_lean', 'back_lean'];
const POSTURE_META = {
  normal: { name: '标准坐姿', shortName: '标准', color: '#36c982' },
  front_lean: { name: '身体前倾', shortName: '前倾', color: '#ff9b67' },
  left_lean: { name: '左侧倾斜', shortName: '左倾', color: '#66a9ef' },
  right_lean: { name: '右侧倾斜', shortName: '右倾', color: '#f3c45d' },
  back_lean: { name: '身体后倾', shortName: '后倾', color: '#a98bdd' }
};
const ADVICE_META = {
  front_lean: { issue: '前倾时间较长', advice: '提醒孩子抬头远眺，并做 1～2 分钟肩颈放松。' },
  left_lean: { issue: '身体容易向左偏', advice: '检查桌椅是否居中，提醒双脚平放、身体回到坐垫中央。' },
  right_lean: { issue: '身体容易向右偏', advice: '检查书本与屏幕位置，避免长期单侧支撑身体。' },
  back_lean: { issue: '后倾次数偏多', advice: '适当调整椅背距离，让腰背保持自然支撑。' },
  normal: { issue: '今天整体较稳定', advice: '继续保持当前习惯，每学习 40 分钟起身活动一次。' }
};

function clamp(value, min, max) { return Math.max(min, Math.min(max, Number(value) || 0)); }
function percent(value) { return Math.round(clamp(value, 0, 1) * 100); }

function formatDuration(seconds) {
  const safe = Math.max(0, Math.round(Number(seconds) || 0));
  if (safe < 60) return `${safe} 秒`;
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  if (hours) return `${hours} 小时${minutes ? ` ${minutes} 分` : ''}`;
  return `${minutes} 分钟`;
}

function localDateText(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function effectiveHistory(history) {
  return (history || []).filter((item) => EFFECTIVE_POSTURES.includes(item.postureCode));
}

function summarizeHistory(history) {
  const effective = effectiveHistory(history);
  const counts = {};
  let asymmetryTotal = 0;
  effective.forEach((item) => {
    counts[item.postureCode] = (counts[item.postureCode] || 0) + 1;
    asymmetryTotal += Number(item.pressureFeatures && item.pressureFeatures.asymmetryIndex !== undefined
      ? item.pressureFeatures.asymmetryIndex
      : Number(item.asymmetryPercent || 0) / 100) || 0;
  });
  return {
    effectiveCount: effective.length,
    counts,
    normalRatio: effective.length ? Number(counts.normal || 0) / effective.length : 0,
    avgAsymmetry: effective.length ? asymmetryTotal / effective.length : 0
  };
}

function buildScore(daily, todaySummary, previousNormalRatio) {
  const totalSeconds = Number(daily && daily.total_sitting_s || 0);
  const hasData = totalSeconds > 0 || todaySummary.effectiveCount > 0;
  if (!hasData) {
    return { score: 0, label: '等待今日数据', tone: 'waiting', changeText: '连接坐垫后开始分析', normalPercent: 0 };
  }
  const normalRatio = totalSeconds > 0 ? clamp(daily.normal_ratio, 0, 1) : todaySummary.normalRatio;
  const asymmetry = totalSeconds > 0 ? Number(daily.avg_asymmetry_index || 0) : todaySummary.avgAsymmetry;
  const reminders = Number(daily && daily.reminder_count || 0);
  const longestPoor = Number(daily && daily.max_poor_posture_duration_s || 0);
  // 面向家长的前端解释性评分：标准坐姿 60%，身体平衡 20%，提醒与连续异常各 10%。
  // 原始统计仍完全来自后端；该分数不是医学评分，也不写回后端。
  const score = Math.round(
    normalRatio * 60
    + (1 - clamp(asymmetry / 0.35, 0, 1)) * 20
    + (1 - clamp(reminders / 8, 0, 1)) * 10
    + (1 - clamp(longestPoor / 300, 0, 1)) * 10
  );
  const delta = previousNormalRatio === null || previousNormalRatio === undefined
    ? null : Math.round((normalRatio - previousNormalRatio) * 100);
  return {
    score: clamp(score, 0, 100),
    label: score >= 85 ? '坐姿表现良好' : (score >= 70 ? '整体表现稳定' : (score >= 50 ? '仍有改善空间' : '今天需要多关注')),
    tone: score >= 85 ? 'excellent' : (score >= 70 ? 'good' : (score >= 50 ? 'watch' : 'attention')),
    changeText: delta === null ? `标准坐姿 ${percent(normalRatio)}%` : `标准坐姿较昨日 ${delta >= 0 ? '↑' : '↓'}${Math.abs(delta)}%`,
    normalPercent: percent(normalRatio)
  };
}

function buildPostureComposition(history) {
  const summary = summarizeHistory(history);
  let cursor = 0;
  const gradientParts = [];
  const items = EFFECTIVE_POSTURES.map((key) => {
    const rawPercent = summary.effectiveCount ? Number(summary.counts[key] || 0) / summary.effectiveCount * 100 : 0;
    const start = cursor;
    cursor += rawPercent;
    if (rawPercent > 0) gradientParts.push(`${POSTURE_META[key].color} ${start.toFixed(2)}% ${cursor.toFixed(2)}%`);
    return {
      key,
      name: POSTURE_META[key].shortName,
      fullName: POSTURE_META[key].name,
      color: POSTURE_META[key].color,
      percent: Math.round(rawPercent)
    };
  });
  const abnormalItems = items.filter((item) => item.key !== 'normal').sort((left, right) => right.percent - left.percent);
  const primary = abnormalItems[0] && abnormalItems[0].percent > 0 ? abnormalItems[0] : items[0];
  const advice = ADVICE_META[primary.key] || ADVICE_META.normal;
  return {
    items,
    normalPercent: items[0].percent,
    donutStyle: gradientParts.length ? `background: conic-gradient(${gradientParts.join(',')});` : 'background:#e7eeea;',
    primaryIssue: advice.issue,
    primaryAdvice: advice.advice,
    effectiveCount: summary.effectiveCount
  };
}

function mainPostureText(records) {
  const summary = summarizeHistory(records);
  if (!summary.effectiveCount) return { mood: '—', title: '暂无数据', detail: '等待坐垫上传' };
  const abnormal = Object.keys(summary.counts)
    .filter((key) => key !== 'normal')
    .sort((left, right) => Number(summary.counts[right] || 0) - Number(summary.counts[left] || 0))[0];
  const normalPercent = percent(summary.normalRatio);
  return {
    mood: normalPercent >= 75 ? '😊' : (normalPercent >= 55 ? '😐' : '😟'),
    title: normalPercent >= 75 ? '状态稳定' : ((POSTURE_META[abnormal] || {}).shortName ? `${POSTURE_META[abnormal].shortName}偏多` : '需要关注'),
    detail: `标准坐姿 ${normalPercent}%`
  };
}

function buildDayTimeline(history, now) {
  const today = localDateText(now);
  const todayRecords = (history || []).filter((item) => localDateText(new Date(item.recordedAt)) === today);
  const definitions = [
    { key: 'morning', label: '上午', range: '06–12', start: 6, end: 12 },
    { key: 'afternoon', label: '下午', range: '12–18', start: 12, end: 18 },
    { key: 'evening', label: '晚间', range: '18–24', start: 18, end: 24 }
  ];
  const segments = definitions.map((definition) => {
    const records = todayRecords.filter((item) => {
      const hour = new Date(item.recordedAt).getHours();
      return hour >= definition.start && hour < definition.end;
    });
    return Object.assign({}, definition, mainPostureText(records));
  });
  return { segments, todayRecordCount: todayRecords.length };
}

function buildAdvice(history, composition, now) {
  const today = localDateText(now);
  const buckets = {};
  (history || []).forEach((item) => {
    if (localDateText(new Date(item.recordedAt)) !== today || !EFFECTIVE_POSTURES.includes(item.postureCode) || item.postureCode === 'normal') return;
    const hour = new Date(item.recordedAt).getHours();
    if (!buckets[hour]) buckets[hour] = { count: 0, postures: {} };
    buckets[hour].count += 1;
    buckets[hour].postures[item.postureCode] = (buckets[hour].postures[item.postureCode] || 0) + 1;
  });
  const peakHour = Object.keys(buckets).sort((left, right) => buckets[right].count - buckets[left].count)[0];
  const primaryKey = composition.items.filter((item) => item.key !== 'normal').sort((left, right) => right.percent - left.percent)[0];
  const meta = primaryKey && primaryKey.percent > 0 ? (ADVICE_META[primaryKey.key] || ADVICE_META.normal) : ADVICE_META.normal;
  return {
    eyebrow: peakHour !== undefined ? `今日 ${String(peakHour).padStart(2, '0')}:00–${String(Number(peakHour) + 1).padStart(2, '0')}:00` : '今日坐姿观察',
    title: peakHour !== undefined ? meta.issue : '暂未发现明显异常时段',
    text: peakHour !== undefined ? meta.advice : '继续保持双脚平放，并在连续学习后安排短暂活动。'
  };
}

function previousActiveNormalRatio(weekly, today) {
  const items = weekly && weekly.daily_items || [];
  const active = items.filter((item) => item.date < today && Number(item.total_sitting_s || 0) > 0);
  return active.length ? Number(active[active.length - 1].normal_ratio || 0) : null;
}

function buildTrend(history, tab, weekly) {
  if (tab === 'week' && weekly && weekly.daily_items) {
    return weekly.daily_items.map((item) => Number(item.total_sitting_s || 0) > 0 ? Number(item.avg_asymmetry_index || 0) : null);
  }
  const groups = {};
  effectiveHistory(history).forEach((item) => {
    const date = new Date(item.recordedAt);
    const key = tab === 'day'
      ? `${String(date.getHours()).padStart(2, '0')}:00`
      : (tab === 'year' ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}` : localDateText(date));
    if (!groups[key]) groups[key] = { total: 0, count: 0 };
    groups[key].total += Number(item.pressureFeatures && item.pressureFeatures.asymmetryIndex !== undefined ? item.pressureFeatures.asymmetryIndex : item.asymmetryPercent / 100) || 0;
    groups[key].count += 1;
  });
  return Object.keys(groups).sort().map((key) => groups[key].total / groups[key].count);
}

function average(values) {
  const valid = (values || []).filter((value) => value !== null && value !== undefined && !Number.isNaN(Number(value)));
  return valid.length ? valid.reduce((sum, value) => sum + Number(value), 0) / valid.length : 0;
}

function buildBalance(trendValues, previousWeekly) {
  const currentAverage = average(trendValues);
  let previousAverage = null;
  let comparePrefix = '较前半周期';
  if (previousWeekly && Number(previousWeekly.total_sitting_s || 0) > 0) {
    previousAverage = Number(previousWeekly.avg_asymmetry_index || 0);
    comparePrefix = '较上周';
  } else {
    const middle = Math.max(1, Math.floor((trendValues || []).length / 2));
    const first = average((trendValues || []).slice(0, middle));
    if (first > 0) previousAverage = first;
  }
  const delta = previousAverage === null ? null : currentAverage - previousAverage;
  const direction = delta === null || Math.abs(delta) < 0.005 ? 'stable' : (delta < 0 ? 'down' : 'up');
  return {
    averagePercent: (currentAverage * 100).toFixed(1),
    level: currentAverage <= 0.15 ? '压力分布较均衡' : (currentAverage <= 0.3 ? '存在轻微不均衡' : '压力偏差需要关注'),
    levelTone: currentAverage <= 0.15 ? 'good' : (currentAverage <= 0.3 ? 'watch' : 'attention'),
    changeText: delta === null ? '暂无上一阶段数据' : `${comparePrefix}${direction === 'down' ? '下降' : (direction === 'up' ? '上升' : '基本持平')} ${Math.abs(delta * 100).toFixed(1)}%`,
    direction,
    explanation: '数值越低，说明左右与前后压力越均衡，坐姿通常越稳定。'
  };
}

function buildDashboard(options) {
  const daily = options.daily || null;
  const weekly = options.weekly || null;
  const history = options.history || [];
  const now = options.now || new Date();
  const today = localDateText(now);
  const todayHistory = history.filter((item) => localDateText(new Date(item.recordedAt)) === today);
  const todaySummary = summarizeHistory(todayHistory);
  const composition = buildPostureComposition(history);
  const todayComposition = buildPostureComposition(todayHistory);
  const trendValues = buildTrend(history, options.tab || 'week', weekly);
  return {
    score: buildScore(
      daily,
      todaySummary,
      options.previousNormalRatio !== undefined
        ? options.previousNormalRatio
        : previousActiveNormalRatio(weekly, today)
    ),
    balance: buildBalance(trendValues, options.previousWeekly),
    composition,
    todayComposition,
    timeline: buildDayTimeline(history, now),
    advice: buildAdvice(history, todayComposition, now),
    trendValues,
    sampleCount: history.length,
    todayCorrectText: formatDuration(daily && daily.normal_sitting_s),
    longestPoorText: formatDuration(daily && daily.max_poor_posture_duration_s),
    reminderCount: Number(daily && daily.reminder_count || 0)
  };
}

module.exports = { buildDashboard, formatDuration, localDateText };
