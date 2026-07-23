(function exposeExerciseGuide(global) {
  const STORAGE_KEY = "sg.exercise.guide.v1";
  const VALID_POSTURES = ["normal", "left_lean", "right_lean", "front_lean", "back_lean"];

  const catalog = [
    {
      id: "cat_breath", name: "猫式呼吸", category: "腰背恢复", icon: "◒", pose: "cat",
      durationSeconds: 45, level: "入门", target: "放松腰背与肩颈",
      tags: ["front_lean", "back_lean", "long_sit"], suggestion: "45 秒 × 2 组",
      steps: ["四点跪姿，双手位于肩部正下方", "呼气时缓慢拱背并放松颈部", "吸气时回到自然中立位", "全程缓慢呼吸，不追求大幅度"],
      caution: "手腕或腰背不适时减小幅度；出现疼痛应立即停止。",
    },
    {
      id: "plank", name: "平板支撑", category: "核心稳定", icon: "━", pose: "plank",
      durationSeconds: 30, level: "进阶", target: "激活核心稳定",
      tags: ["front_lean", "back_lean", "long_sit"], suggestion: "30 秒 × 2～3 组",
      steps: ["双肘放在肩部正下方", "膝盖或脚尖支撑地面", "保持头、背、髋部在一条直线上", "收紧腹部并保持自然呼吸"],
      caution: "腰部不要下沉；力量不足时采用屈膝版本。",
    },
    {
      id: "side_stretch", name: "左右侧伸", category: "拉伸恢复", icon: "↔", pose: "side",
      durationSeconds: 40, level: "入门", target: "缓解身体偏斜",
      tags: ["left_lean", "right_lean", "long_sit"], suggestion: "左右各 20 秒",
      steps: ["坐直或站直，双脚稳定支撑", "一侧手臂举过头顶", "身体向对侧缓慢侧弯", "回到中立位后换另一侧"],
      caution: "骨盆保持稳定，不要快速弹动或憋气。",
    },
    {
      id: "dead_bug", name: "死虫运动", category: "核心稳定", icon: "✣", pose: "deadbug",
      durationSeconds: 45, level: "进阶", target: "改善躯干控制",
      tags: ["back_lean", "front_lean"], suggestion: "左右交替 8 次",
      steps: ["仰卧，髋膝弯曲约 90°", "收紧腹部，让腰背自然贴近垫面", "缓慢伸展对侧手臂和腿", "回到起点后换边"],
      caution: "腰背拱起时缩小动作范围。",
    },
    {
      id: "glute_bridge", name: "臀桥", category: "臀腿激活", icon: "⌒", pose: "bridge",
      durationSeconds: 45, level: "入门", target: "改善骨盆稳定",
      tags: ["left_lean", "right_lean", "back_lean"], suggestion: "10 次 × 2 组",
      steps: ["仰卧屈膝，双脚与髋同宽", "脚掌均匀压地", "收紧臀部并缓慢抬起髋部", "停留一秒后有控制地落下"],
      caution: "不要过度挺腰，膝盖保持朝向脚尖。",
    },
    {
      id: "single_bridge", name: "交替臀桥", category: "臀腿激活", icon: "⌁", pose: "bridge",
      durationSeconds: 40, level: "进阶", target: "加强左右稳定",
      tags: ["left_lean", "right_lean"], suggestion: "左右各 6 次",
      steps: ["先完成标准臀桥起始姿势", "抬起髋部并保持骨盆水平", "交替轻抬一只脚", "动作缓慢，避免身体左右晃动"],
      caution: "无法保持骨盆水平时改做普通臀桥。",
    },
    {
      id: "neck_relax", name: "肩颈放松", category: "拉伸恢复", icon: "⌄", pose: "neck",
      durationSeconds: 40, level: "入门", target: "缓解低头和肩颈紧张",
      tags: ["front_lean", "long_sit", "reminders"], suggestion: "左右各 20 秒",
      steps: ["坐直，肩膀自然下沉", "头部缓慢向一侧倾斜", "保持下巴微收，不耸肩", "回正后换另一侧"],
      caution: "只做轻柔牵伸，不用手强压头部。",
    },
    {
      id: "standing_reach", name: "站立伸展", category: "久坐恢复", icon: "↑", pose: "stand",
      durationSeconds: 30, level: "入门", target: "打断久坐并舒展全身",
      tags: ["long_sit", "reminders", "normal"], suggestion: "30 秒，配合远眺",
      steps: ["离开座位，双脚与髋同宽", "双手向上延伸，肩膀保持放松", "缓慢吸气和呼气三次", "放下手臂并远眺 20 秒"],
      caution: "确认周围空间安全，避免快速后仰。",
    },
  ];

  function localDate(offset = 0) {
    const date = new Date(Date.now() + offset * 86400000);
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(date);
  }

  function loadLocal() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      return saved && typeof saved === "object" ? saved : { recentViews: [], recentGuides: [], planDays: {} };
    } catch (_) {
      return { recentViews: [], recentGuides: [], planDays: {} };
    }
  }

  function saveLocal(data) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    return data;
  }

  function record(kind, exerciseIds) {
    const data = loadLocal();
    const key = kind === "guide" ? "recentGuides" : "recentViews";
    const ids = Array.isArray(exerciseIds) ? exerciseIds : [exerciseIds];
    const entry = { ids, at: new Date().toISOString() };
    data[key] = [entry, ...(data[key] || [])].slice(0, 8);
    if (kind === "guide") data.planDays[localDate()] = { guided: true, ids, at: entry.at };
    return saveLocal(data);
  }

  function sevenDayPlan() {
    const data = loadLocal();
    return Array.from({ length: 7 }, (_, index) => {
      const offset = index - 6;
      const date = localDate(offset);
      return { date, label: index === 6 ? "今天" : new Date(`${date}T00:00:00+08:00`).toLocaleDateString("zh-CN", { weekday: "short" }), guided: Boolean(data.planDays?.[date]?.guided) };
    });
  }

  function latestCode(latest) {
    return latest?.postureCode || latest?.posture || "unknown";
  }

  function analyze({ history = [], daily = null, latest = null } = {}) {
    const counts = Object.fromEntries(["normal", "left_lean", "right_lean", "front_lean", "back_lean", "empty", "unknown"].map((key) => [key, 0]));
    let asymmetryTotal = 0;
    let asymmetrySamples = 0;
    history.forEach((item) => {
      const code = item.postureCode || item.posture || "unknown";
      counts[code] = (counts[code] || 0) + 1;
      const value = Number(item.pressureFeatures?.asymmetryIndex ?? item.pressure_features?.asymmetry_index);
      if (Number.isFinite(value)) { asymmetryTotal += value; asymmetrySamples += 1; }
    });
    const measured = VALID_POSTURES.reduce((sum, key) => sum + counts[key], 0);
    const abnormalCodes = ["front_lean", "left_lean", "right_lean", "back_lean"];
    const dominant = abnormalCodes.sort((a, b) => counts[b] - counts[a])[0];
    const dominantCode = counts[dominant] > 0 ? dominant : (VALID_POSTURES.includes(latestCode(latest)) ? latestCode(latest) : "normal");
    const sittingSeconds = Number(daily?.total_sitting_s ?? latest?.sittingDurationSeconds ?? latest?.sitting_duration_s ?? 0);
    const normalRatio = Number(daily?.normal_ratio ?? (measured ? counts.normal / measured : latestCode(latest) === "normal" ? 1 : 0));
    const reminderCount = Number(daily?.reminder_count ?? latest?.reminderCount ?? latest?.reminder_count ?? 0);
    const asymmetry = Number(daily?.avg_asymmetry_index ?? (asymmetrySamples ? asymmetryTotal / asymmetrySamples : latest?.pressureFeatures?.asymmetryIndex ?? latest?.pressure_features?.asymmetry_index ?? 0));
    const percentages = Object.fromEntries(VALID_POSTURES.map((key) => [key, measured ? Math.round(counts[key] / measured * 100) : 0]));
    const longSit = sittingSeconds >= 1800;
    const reasons = [];
    const postureNames = { normal: "近期姿态整体稳定", front_lean: "前倾采样相对突出", left_lean: "左倾采样相对突出", right_lean: "右倾采样相对突出", back_lean: "后倾采样相对突出" };
    reasons.push(postureNames[dominantCode] || "等待更多姿态数据");
    if (longSit) reasons.push(`累计有效就坐约 ${Math.round(sittingSeconds / 60)} 分钟`);
    else reasons.push(`当前有效就坐约 ${Math.round(sittingSeconds / 60)} 分钟`);
    if (reminderCount >= 3) reasons.push(`今日已记录 ${reminderCount} 次提醒`);
    else reasons.push(`今日提醒 ${reminderCount} 次`);
    if (asymmetry >= 0.18) reasons.push(`压力不对称指数约 ${Math.round(asymmetry * 100)}%`);

    const scores = new Map(catalog.map((item) => [item.id, 0]));
    catalog.forEach((item) => {
      if (item.tags.includes(dominantCode)) scores.set(item.id, scores.get(item.id) + 5);
      if (longSit && item.tags.includes("long_sit")) scores.set(item.id, scores.get(item.id) + 4);
      if (reminderCount >= 3 && item.tags.includes("reminders")) scores.set(item.id, scores.get(item.id) + 3);
      if (dominantCode === "normal" && item.tags.includes("normal")) scores.set(item.id, scores.get(item.id) + 2);
    });
    const recommended = [...catalog].sort((a, b) => scores.get(b.id) - scores.get(a.id) || a.durationSeconds - b.durationSeconds).slice(0, 3).map((item, index) => ({
      ...item,
      score: Math.max(78, 96 - index * 6),
      reason: item.tags.includes(dominantCode) ? `针对${postureNames[dominantCode].replace("采样相对突出", "")}` : longSit && item.tags.includes("long_sit") ? "用于打断连续久坐" : "作为本轮补充训练",
    }));
    return { counts, percentages, dominantCode, sittingSeconds, normalRatio, reminderCount, asymmetry, reasons, recommended, sampleCount: history.length };
  }

  global.SpineGuardExerciseGuide = {
    catalog,
    categories: [...new Set(catalog.map((item) => item.category))],
    analyze,
    getById: (id) => catalog.find((item) => item.id === id) || catalog[0],
    recordView: (id) => record("view", id),
    recordGuide: (ids) => record("guide", ids),
    getLocalState: loadLocal,
    sevenDayPlan,
  };
})(window);
