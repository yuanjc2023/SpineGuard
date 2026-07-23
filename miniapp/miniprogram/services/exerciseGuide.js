const telemetryService = require('./telemetry');
const aiAssistant = require('./aiAssistant');

const STORAGE_KEY = 'spineExerciseGuideV1';
const GUIDE_DRAFT_KEY = 'spineExerciseGuideDraftV1';

const catalog = [
  { id: 'cat_breath', name: '猫式呼吸', category: '腰背恢复', pose: 'cat', durationSeconds: 45, level: '入门', target: '放松腰背与肩颈', tags: ['front_lean', 'back_lean', 'long_sit'], suggestion: '45秒 × 2组', steps: ['四点跪姿，双手位于肩部正下方', '呼气时缓慢拱背并放松颈部', '吸气时回到自然中立位', '全程缓慢呼吸，不追求大幅度'], caution: '手腕或腰背不适时减小幅度；出现疼痛立即停止。' },
  { id: 'plank', name: '平板支撑', category: '核心稳定', pose: 'plank', durationSeconds: 30, level: '进阶', target: '激活核心稳定', tags: ['front_lean', 'back_lean', 'long_sit'], suggestion: '30秒 × 2～3组', steps: ['双肘放在肩部正下方', '膝盖或脚尖支撑地面', '保持头、背、髋部在一条直线上', '收紧腹部并保持自然呼吸'], caution: '腰部不要下沉；力量不足时采用屈膝版本。' },
  { id: 'side_stretch', name: '左右侧伸', category: '拉伸恢复', pose: 'side', durationSeconds: 40, level: '入门', target: '缓解身体偏斜', tags: ['left_lean', 'right_lean', 'long_sit'], suggestion: '左右各20秒', steps: ['坐直或站直，双脚稳定支撑', '一侧手臂举过头顶', '身体向对侧缓慢侧弯', '回到中立位后换另一侧'], caution: '骨盆保持稳定，不要快速弹动或憋气。' },
  { id: 'dead_bug', name: '死虫运动', category: '核心稳定', pose: 'deadbug', durationSeconds: 45, level: '进阶', target: '改善躯干控制', tags: ['back_lean', 'front_lean'], suggestion: '左右交替8次', steps: ['仰卧，髋膝弯曲约90°', '收紧腹部，让腰背自然贴近垫面', '缓慢伸展对侧手臂和腿', '回到起点后换边'], caution: '腰背拱起时缩小动作范围。' },
  { id: 'glute_bridge', name: '臀桥', category: '臀腿激活', pose: 'bridge', durationSeconds: 45, level: '入门', target: '改善骨盆稳定', tags: ['left_lean', 'right_lean', 'back_lean'], suggestion: '10次 × 2组', steps: ['仰卧屈膝，双脚与髋同宽', '脚掌均匀压地', '收紧臀部并缓慢抬起髋部', '停留一秒后有控制地落下'], caution: '不要过度挺腰，膝盖保持朝向脚尖。' },
  { id: 'single_bridge', name: '交替臀桥', category: '臀腿激活', pose: 'bridge', durationSeconds: 40, level: '进阶', target: '加强左右稳定', tags: ['left_lean', 'right_lean'], suggestion: '左右各6次', steps: ['先完成标准臀桥起始姿势', '抬起髋部并保持骨盆水平', '交替轻抬一只脚', '动作缓慢，避免身体左右晃动'], caution: '无法保持骨盆水平时改做普通臀桥。' },
  { id: 'neck_relax', name: '肩颈放松', category: '拉伸恢复', pose: 'neck', durationSeconds: 40, level: '入门', target: '缓解低头和肩颈紧张', tags: ['front_lean', 'long_sit', 'reminders'], suggestion: '左右各20秒', steps: ['坐直，肩膀自然下沉', '头部缓慢向一侧倾斜', '保持下巴微收，不耸肩', '回正后换另一侧'], caution: '只做轻柔牵伸，不用手强压头部。' },
  { id: 'standing_reach', name: '站立伸展', category: '久坐恢复', pose: 'stand', durationSeconds: 30, level: '入门', target: '打断久坐并舒展全身', tags: ['long_sit', 'reminders', 'normal'], suggestion: '30秒，配合远眺', steps: ['离开座位，双脚与髋同宽', '双手向上延伸，肩膀保持放松', '缓慢吸气和呼气三次', '放下手臂并远眺20秒'], caution: '确认周围空间安全，避免快速后仰。' }
];

function localDate(offset) {
  const date = new Date(Date.now() + (offset || 0) * 86400000 + 8 * 3600000);
  return date.toISOString().slice(0, 10);
}
function loadLocal() { return wx.getStorageSync(STORAGE_KEY) || { recentViews: [], recentGuides: [], planDays: {} }; }
function saveLocal(data) { wx.setStorageSync(STORAGE_KEY, data); return data; }
function record(kind, ids) {
  const data = loadLocal(); const list = Array.isArray(ids) ? ids : [ids]; const at = new Date().toISOString();
  const key = kind === 'guide' ? 'recentGuides' : 'recentViews';
  data[key] = [{ ids: list, at }].concat(data[key] || []).slice(0, 8);
  if (kind === 'guide') data.planDays[localDate()] = { guided: true, ids: list, at };
  return saveLocal(data);
}
function getById(id) { return catalog.find((item) => item.id === id) || catalog[0]; }
function sevenDayPlan() {
  const data = loadLocal();
  return Array.from({ length: 7 }, (_, index) => {
    const date = localDate(index - 6); const day = new Date(`${date}T00:00:00+08:00`);
    return { date, shortDate: date.slice(5), label: index === 6 ? '今天' : ['日','一','二','三','四','五','六'][day.getDay()], guided: !!(data.planDays[date] && data.planDays[date].guided) };
  });
}
function analyze(history, daily, latest) {
  const codes = ['normal','left_lean','right_lean','front_lean','back_lean'];
  const counts = { normal: 0, left_lean: 0, right_lean: 0, front_lean: 0, back_lean: 0 };
  let asymmetryTotal = 0;
  (history || []).forEach((item) => { if (counts[item.postureCode] !== undefined) counts[item.postureCode] += 1; asymmetryTotal += Number(item.pressureFeatures && item.pressureFeatures.asymmetryIndex) || 0; });
  const measured = codes.reduce((sum, key) => sum + counts[key], 0);
  const abnormal = ['front_lean','left_lean','right_lean','back_lean'].sort((a,b) => counts[b] - counts[a]);
  const dominantCode = counts[abnormal[0]] > 0 ? abnormal[0] : (codes.indexOf(latest && latest.postureCode) >= 0 ? latest.postureCode : 'normal');
  const sittingSeconds = Number(daily && daily.total_sitting_s !== undefined ? daily.total_sitting_s : latest && latest.sittingDurationSeconds) || 0;
  const reminderCount = Number(daily && daily.reminder_count !== undefined ? daily.reminder_count : latest && latest.reminderCount) || 0;
  const asymmetry = Number(daily && daily.avg_asymmetry_index !== undefined ? daily.avg_asymmetry_index : measured ? asymmetryTotal / measured : latest && latest.pressureFeatures && latest.pressureFeatures.asymmetryIndex) || 0;
  const names = { normal: '近期姿态整体稳定', front_lean: '前倾采样相对突出', left_lean: '左倾采样相对突出', right_lean: '右倾采样相对突出', back_lean: '后倾采样相对突出' };
  const reasons = [names[dominantCode], `${sittingSeconds >= 1800 ? '累计' : '当前'}有效就坐约 ${Math.round(sittingSeconds / 60)} 分钟`, `今日提醒 ${reminderCount} 次`];
  if (asymmetry >= .18) reasons.push(`压力不对称指数约 ${Math.round(asymmetry * 100)}%`);
  const scores = {};
  catalog.forEach((item) => { scores[item.id] = (item.tags.indexOf(dominantCode) >= 0 ? 5 : 0) + (sittingSeconds >= 1800 && item.tags.indexOf('long_sit') >= 0 ? 4 : 0) + (reminderCount >= 3 && item.tags.indexOf('reminders') >= 0 ? 3 : 0) + (dominantCode === 'normal' && item.tags.indexOf('normal') >= 0 ? 2 : 0); });
  const recommended = catalog.slice().sort((a,b) => scores[b.id] - scores[a.id] || a.durationSeconds - b.durationSeconds).slice(0,3).map((item,index) => Object.assign({}, item, { score: Math.max(78,96-index*6), reason: item.tags.indexOf(dominantCode) >= 0 ? `针对${names[dominantCode].replace('采样相对突出','')}` : '作为本轮补充训练' }));
  const percentages = {}; codes.forEach((key) => { percentages[key] = measured ? Math.round(counts[key] / measured * 100) : 0; });
  return { counts, percentages, dominantCode, sittingSeconds, reminderCount, asymmetry, reasons, recommended, sampleCount: (history || []).length };
}
function loadContext() {
  const device = wx.getStorageSync('boundDevice') || {}; const deviceId = device.deviceCode || telemetryService.defaultDeviceId;
  return Promise.all([
    telemetryService.getLatestTelemetry(deviceId).catch(() => null),
    telemetryService.getTelemetryHistory(deviceId, 200).catch(() => []),
    telemetryService.getDailyStat(localDate()).catch(() => null)
  ]).then(([latest, history, daily]) => analyze(history, daily, latest));
}
function aiExplain(context) {
  const student = wx.getStorageSync('currentStudent') || {};
  if (!student.student_id || telemetryService.getTelemetryMode() === 'Mock') return Promise.resolve({ reply: '当前为本地演示，推荐由可解释规则生成，未调用云端AI。', source: 'rule' });
  const question = `请仅根据今日坐姿数据简洁解释为什么推荐${context.recommended.map((item) => item.name).join('、')}，不要判断动作完成，不要承诺奖励，也不要给出医学诊断。`;
  return aiAssistant.chat(student.student_id, question, localDate(), []).then((result) => ({ reply: result.reply, source: result.generated_by || 'assistant' }));
}
function saveDraft(draft) { if (draft) wx.setStorageSync(GUIDE_DRAFT_KEY, draft); else wx.removeStorageSync(GUIDE_DRAFT_KEY); }
function loadDraft() { return wx.getStorageSync(GUIDE_DRAFT_KEY) || null; }

module.exports = { catalog, categories: Array.from(new Set(catalog.map((item) => item.category))), getById, analyze, loadContext, aiExplain, recordView: (id) => record('view', id), recordGuide: (ids) => record('guide', ids), loadLocal, sevenDayPlan, saveDraft, loadDraft };
