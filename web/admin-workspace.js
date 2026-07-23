(function exposeAdminWorkspace(global) {
  const POSTURE_META = {
    normal: { label: "标准坐姿", short: "标准", color: "#39ffb6" },
    left_lean: { label: "左倾", short: "左倾", color: "#ffd166" },
    right_lean: { label: "右倾", short: "右倾", color: "#ffb35c" },
    front_lean: { label: "前倾", short: "前倾", color: "#ff7d7d" },
    back_lean: { label: "后仰", short: "后仰", color: "#d899ff" },
    empty: { label: "暂时离座", short: "离座", color: "#78a9bd" },
    unknown: { label: "暂无数据", short: "其他", color: "#718795" },
    offline: { label: "设备离线", short: "离线", color: "#455966" },
  };
  const RISK_LABELS = { red: "红色", yellow: "黄色", green: "绿色", unknown: "未评估" };
  const STAGES = ["seed", "sprout", "sapling", "tree", "flower", "fruit"];

  const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[char]);
  const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
  const percent = (value) => `${Math.round(number(value) * 100)}%`;
  const minutes = (seconds) => `${Math.round(number(seconds) / 60)} 分钟`;
  const dateText = (date = new Date()) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  };
  const formatTime = (value) => {
    if (!value) return "尚未上传";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "--" : date.toLocaleString("zh-CN", { hour12: false });
  };
  const resultData = (result) => result?.data || result || null;
  const resultItems = (result) => Array.isArray(result?.items) ? result.items : [];
  const safeCall = async (request, fallback = null) => {
    try { return await request(); } catch (_) { return fallback; }
  };
  async function mapLimit(items, limit, worker) {
    const results = new Array(items.length);
    let cursor = 0;
    async function run() {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await worker(items[index], index);
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
    return results;
  }
  function startOfWeek(offsetWeeks = 0) {
    const date = new Date();
    const day = date.getDay() || 7;
    date.setDate(date.getDate() - day + 1 + offsetWeeks * 7);
    return dateText(date);
  }

  class AdminWorkspace {
    constructor(api, options = {}) {
      this.api = api;
      this.toast = options.toast || (() => {});
      this.data = {
        overview: {}, classes: [], risks: [], devices: [], students: [], classStudents: [],
        snapshots: new Map(), stats: new Map(), previousStats: new Map(), histories: new Map(),
        gardens: new Map(), weekly: new Map(),
      };
      this.selectedClass = localStorage.getItem("sg.admin.class") || "";
      this.riskFilter = "all";
      this.riskSearch = "";
      this.deviceSearch = "";
      this.postureFilter = "all";
      this.rankingMode = "standard";
      this.loadedAt = 0;
      this.loading = null;
      this.eventsReady = false;
    }

    async load(force = false) {
      if (!document.querySelector("#dashboard") || !this.api?.adminOverview) return;
      if (this.loading) return this.loading;
      if (!force && Date.now() - this.loadedAt < 25000) return this.renderAll();
      this.setLiveStatus("数据同步中", true);
      this.loading = this.loadData().finally(() => { this.loading = null; });
      return this.loading;
    }

    async loadData() {
      try {
        const [overview, classes, risks, devices, students] = await Promise.all([
          this.api.adminOverview(), this.api.adminClasses(), this.api.adminRiskStudents("all"),
          this.api.devices(), this.api.students(),
        ]);
        this.data.overview = resultData(overview) || {};
        this.data.classes = resultItems(classes);
        this.data.risks = resultItems(risks);
        this.data.devices = resultItems(devices);
        this.data.students = resultItems(students);
        if (!this.data.classes.some((item) => item.class_id === this.selectedClass)) {
          this.selectedClass = this.data.classes[0]?.class_id || "unassigned";
        }
        localStorage.setItem("sg.admin.class", this.selectedClass);
        this.renderClassSelect();
        await this.loadSelectedClass();
        this.loadedAt = Date.now();
        this.setLiveStatus(`已同步 ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`);
        this.renderAll();
      } catch (error) {
        this.setLiveStatus(`同步失败${error?.message ? ` · ${error.message}` : ""}`, false, true);
        this.renderError(error);
      }
    }

    async loadSelectedClass() {
      const classResult = await safeCall(() => this.api.adminClassStudents(this.selectedClass), null);
      this.data.classStudents = classResult
        ? resultItems(classResult)
        : this.data.students.filter((item) => (item.class_id || "unassigned") === this.selectedClass);
      const today = dateText();
      const yesterdayDate = new Date();
      yesterdayDate.setDate(yesterdayDate.getDate() - 1);
      const yesterday = dateText(yesterdayDate);
      const dayStart = `${today}T00:00:00+08:00`;
      const dayEnd = `${today}T23:59:59+08:00`;
      this.data.snapshots = new Map();
      this.data.stats = new Map();
      this.data.previousStats = new Map();
      this.data.histories = new Map();
      this.data.gardens = new Map();
      await mapLimit(this.data.classStudents, 6, async (student) => {
        const id = student.student_id;
        const [latest, daily, previous, history, garden] = await Promise.all([
          safeCall(() => this.api.studentLatest(id)),
          safeCall(() => this.api.dailyStats(id, today)),
          safeCall(() => this.api.dailyStats(id, yesterday)),
          safeCall(() => this.api.studentHistory(id, { from: dayStart, to: dayEnd, limit: 200 }), { items: [] }),
          safeCall(() => this.api.studentGarden(id)),
        ]);
        if (latest) this.data.snapshots.set(id, resultData(latest));
        if (daily) this.data.stats.set(id, resultData(daily));
        if (previous) this.data.previousStats.set(id, resultData(previous));
        this.data.histories.set(id, resultItems(history));
        if (garden) this.data.gardens.set(id, resultData(garden));
      });
      const selectedIds = new Set(this.data.classStudents.map((student) => student.student_id));
      await mapLimit(this.data.students.filter((student) => !selectedIds.has(student.student_id)), 8, async (student) => {
        const latest = await safeCall(() => this.api.studentLatest(student.student_id));
        if (latest) this.data.snapshots.set(student.student_id, resultData(latest));
      });
    }

    renderClassSelect() {
      const select = document.querySelector("#admin-class-select");
      if (!select) return;
      select.innerHTML = this.data.classes.map((item) => `<option value="${escapeHtml(item.class_id)}">${escapeHtml(item.class_id || "未分班")} · ${number(item.student_count)} 人</option>`).join("");
      select.value = this.selectedClass;
    }

    renderAll() {
      this.renderOverview();
      this.renderForest();
      this.renderComposition();
      this.renderAbnormalBars();
      this.renderInsights();
      this.renderRanking();
      this.renderRiskCenter();
      this.renderDevices();
      this.renderReportCenter();
      requestAnimationFrame(() => this.drawTrend());
      this.initEvents();
    }

    classSummary() {
      return this.data.classes.find((item) => item.class_id === this.selectedClass) || {};
    }

    weightedRatio(statsMap = this.data.stats) {
      let normal = 0;
      let total = 0;
      this.data.classStudents.forEach((student) => {
        const stat = statsMap.get(student.student_id);
        normal += number(stat?.normal_sitting_s);
        total += number(stat?.total_sitting_s);
      });
      return total ? normal / total : 0;
    }

    currentPosture(studentId) {
      const telemetry = this.data.snapshots.get(studentId);
      if (!telemetry) return "offline";
      const device = this.data.devices.find((item) => item.device_id === telemetry.device_id);
      const age = Date.now() - number(telemetry.timestamp_ms);
      if (device?.online_status !== "online" || age > 15000) return "offline";
      return POSTURE_META[telemetry.posture] ? telemetry.posture : "unknown";
    }

    renderOverview() {
      const target = document.querySelector("#dashboard-metrics");
      if (!target) return;
      const summary = this.classSummary();
      const stats = [...this.data.stats.values()];
      const monitored = stats.filter((item) => number(item?.total_sitting_s) > 0).length;
      const riskItems = this.data.risks.filter((item) => (item.class_id || "unassigned") === this.selectedClass);
      const red = riskItems.filter((item) => item.risk_level === "red").length;
      const yellow = riskItems.filter((item) => item.risk_level === "yellow").length;
      const totalSeconds = stats.reduce((sum, item) => sum + number(item?.total_sitting_s), 0);
      const abnormal = this.abnormalTotals();
      target.innerHTML = [
        ["设备在线率", `${number(summary.online_device_count)} / ${number(summary.device_count)}`, `${summary.device_count ? Math.round(number(summary.online_device_count) / number(summary.device_count) * 100) : 0}% 在线`],
        ["监测学生数", `${monitored} 人`, `本班共 ${number(summary.student_count)} 人`],
        ["平均标准坐姿率", percent(this.weightedRatio()), `较昨日 ${this.deltaText(this.weightedRatio(), this.weightedRatio(this.data.previousStats))}`],
        ["风险学生", `${red + yellow} 人`, `红色 ${red} · 黄色 ${yellow}`, red ? "risk-red" : yellow ? "risk-yellow" : "risk-green"],
        ["今日监测时长", minutes(totalSeconds), "班级累计有效坐姿记录"],
        ["主要异常姿态", abnormal.top.label, abnormal.total ? `占异常记录 ${abnormal.top.percent}%` : "今日暂无异常"],
      ].map(([label, value, note, cls = ""]) => `<article class="metric-card"><span>${label}</span><strong class="${cls}">${value}</strong><small>${note}</small></article>`).join("");
    }

    deltaText(current, previous) {
      if (!previous) return "暂无对比";
      const delta = (current - previous) * 100;
      return `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%`;
    }

    filteredStudents() {
      if (this.postureFilter === "all") return this.data.classStudents;
      return this.data.classStudents.filter((student) => {
        const posture = this.currentPosture(student.student_id);
        return this.postureFilter === "abnormal"
          ? ["left_lean", "right_lean", "front_lean", "back_lean"].includes(posture)
          : posture === this.postureFilter;
      });
    }

    renderForest() {
      const target = document.querySelector("#admin-student-forest");
      if (!target) return;
      const students = this.filteredStudents();
      const count = document.querySelector("#admin-forest-count");
      if (count) count.textContent = `${students.length} 名学生${this.postureFilter === "all" ? "" : " · 已筛选"}`;
      if (!students.length) {
        target.innerHTML = `<div class="admin-empty">当前筛选下没有学生数据。</div>`;
        return;
      }
      target.innerHTML = students.map((student) => {
        const id = student.student_id;
        const posture = this.currentPosture(id);
        const garden = this.data.gardens.get(id) || {};
        const stage = STAGES.includes(garden.stage) ? garden.stage : "tree";
        const risk = this.data.risks.find((item) => item.student_id === id)?.risk_level || student.risk_level || "unknown";
        return `<button class="admin-student-tree posture-${posture} stage-${stage}" data-admin-student="${escapeHtml(id)}" type="button" aria-label="查看${escapeHtml(student.display_code || id)}详情">
          <span class="admin-tree-risk risk-${escapeHtml(risk)}"></span>
          <span class="admin-mini-tree"><i class="tree-crown-a"></i><i class="tree-crown-b"></i><i class="tree-crown-c"></i><i class="tree-trunk"></i><i class="tree-flower-a"></i><i class="tree-flower-b"></i><i class="tree-fruit-a"></i><i class="tree-fruit-b"></i><i class="tree-ground"></i></span>
          <strong>${escapeHtml(student.display_code || id)}</strong>
        </button>`;
      }).join("");
    }

    postureCounts() {
      const counts = Object.fromEntries(Object.keys(POSTURE_META).map((key) => [key, 0]));
      this.data.classStudents.forEach((student) => { counts[this.currentPosture(student.student_id)] += 1; });
      return counts;
    }

    renderComposition() {
      const target = document.querySelector("#admin-posture-composition");
      if (!target) return;
      const counts = this.postureCounts();
      const total = Math.max(1, this.data.classStudents.length);
      const normalPercent = Math.round(counts.normal / total * 100);
      const abnormalCount = counts.left_lean + counts.right_lean + counts.front_lean + counts.back_lean;
      const entries = ["normal", "left_lean", "right_lean", "front_lean", "back_lean", "empty", "offline"];
      let cursor = 0;
      const stops = entries.map((key) => {
        const start = cursor;
        cursor += counts[key] / total * 360;
        return `${POSTURE_META[key].color} ${start}deg ${cursor}deg`;
      }).join(",");
      target.innerHTML = `<div class="admin-donut" style="background:conic-gradient(${stops || "#455966 0deg 360deg"})"><div><strong>${normalPercent}%</strong><span>标准坐姿</span></div></div><div class="admin-posture-legend">${entries.map((key) => `<button data-posture-filter="${key}" class="${this.postureFilter === key ? "active" : ""}" type="button"><i style="background:${POSTURE_META[key].color}"></i><span>${POSTURE_META[key].short}</span><strong>${counts[key]} 人</strong></button>`).join("")}<button data-posture-filter="abnormal" class="${this.postureFilter === "abnormal" ? "active" : ""}" type="button"><i class="abnormal-dot"></i><span>全部异常</span><strong>${abnormalCount} 人</strong></button></div>`;
    }

    abnormalTotals() {
      const items = [
        ["front_lean_count", "前倾"], ["left_lean_count", "左倾"], ["right_lean_count", "右倾"], ["back_lean_count", "后仰"],
      ].map(([key, label]) => ({ key, label, value: [...this.data.stats.values()].reduce((sum, stat) => sum + number(stat?.[key]), 0) }));
      const total = items.reduce((sum, item) => sum + item.value, 0);
      items.forEach((item) => { item.percent = total ? Math.round(item.value / total * 100) : 0; });
      items.sort((a, b) => b.value - a.value);
      return { items, total, top: total ? items[0] : { label: "暂无", percent: 0 } };
    }

    renderAbnormalBars() {
      const target = document.querySelector("#admin-abnormal-bars");
      if (!target) return;
      const abnormal = this.abnormalTotals();
      target.innerHTML = abnormal.items.map((item) => `<div><span>${item.label}</span><b><i style="width:${item.percent}%"></i></b><strong>${item.percent}%</strong><small>${item.value} 次</small></div>`).join("") || `<div class="admin-empty">今日暂无异常姿态记录。</div>`;
    }

    renderInsights() {
      const target = document.querySelector("#admin-health-insights");
      if (!target) return;
      const current = this.weightedRatio();
      const previous = this.weightedRatio(this.data.previousStats);
      const abnormal = this.abnormalTotals();
      const classRisks = this.data.risks.filter((item) => (item.class_id || "unassigned") === this.selectedClass);
      const topRisk = [...classRisks].sort((a, b) => number(b.risk_score) - number(a.risk_score))[0];
      const deviceIds = new Set([...this.data.snapshots.values()].map((item) => item?.device_id).filter(Boolean));
      const lowBattery = this.data.devices.filter((item) => deviceIds.has(item.device_id) && item.battery_level != null && item.battery_level < 20);
      const insights = [
        `本班今日标准坐姿率为 <strong>${percent(current)}</strong>${previous ? `，较昨日 ${this.deltaText(current, previous)}` : "，昨日数据不足"}。`,
        abnormal.total ? `<strong>${abnormal.top.label}</strong> 是今日最主要的异常姿态，占异常记录 ${abnormal.top.percent}%。` : "今日尚未产生异常姿态记录。",
        topRisk ? `<strong>${escapeHtml(topRisk.display_code || topRisk.student_id)}</strong> 当前风险分数 ${number(topRisk.risk_score)}，${escapeHtml(topRisk.suggestion || "建议持续关注。")}` : "当前没有可用的班级风险评估。",
        lowBattery.length ? `当前有 <strong>${lowBattery.length} 台</strong> 设备电量低于 20%，建议及时充电。` : "已匹配设备中暂无低电量预警。",
      ];
      target.innerHTML = insights.map((text, index) => `<div><span>${String(index + 1).padStart(2, "0")}</span><p>${text}</p></div>`).join("");
    }

    renderRanking() {
      const target = document.querySelector("#admin-ranking-list");
      if (!target) return;
      let rows;
      if (this.rankingMode === "progress") {
        if (!this.data.weekly.size) {
          target.innerHTML = `<div class="admin-empty">正在按学生读取本周与上周统计…</div>`;
          this.loadWeeklyProgress();
          return;
        }
        rows = this.data.classStudents.map((student) => {
          const values = this.data.weekly.get(student.student_id) || {};
          return { student, value: number(values.current?.normal_ratio), delta: (number(values.current?.normal_ratio) - number(values.previous?.normal_ratio)) * 100 };
        }).sort((a, b) => b.delta - a.delta);
      } else {
        rows = this.data.classStudents.map((student) => ({ student, value: number(this.data.stats.get(student.student_id)?.normal_ratio), delta: null })).sort((a, b) => b.value - a.value);
      }
      target.innerHTML = rows.slice(0, 3).map((row, index) => `<button data-admin-student="${escapeHtml(row.student.student_id)}" type="button"><b>${index + 1}</b><span><strong>${escapeHtml(row.student.display_code || row.student.student_id)}</strong><small>${this.rankingMode === "progress" ? `本周 ${percent(row.value)}` : `有效时长 ${minutes(this.data.stats.get(row.student.student_id)?.total_sitting_s)}`}</small></span><em>${this.rankingMode === "progress" ? `${row.delta >= 0 ? "+" : ""}${row.delta.toFixed(1)}%` : percent(row.value)}</em></button>`).join("") || `<div class="admin-empty">暂无可排行数据。</div>`;
    }

    async loadWeeklyProgress() {
      const currentWeek = startOfWeek(0);
      const previousWeek = startOfWeek(-1);
      await mapLimit(this.data.classStudents, 6, async (student) => {
        const [current, previous] = await Promise.all([
          safeCall(() => this.api.weeklyStats(student.student_id, currentWeek)),
          safeCall(() => this.api.weeklyStats(student.student_id, previousWeek)),
        ]);
        this.data.weekly.set(student.student_id, { current: resultData(current), previous: resultData(previous) });
      });
      this.renderRanking();
    }

    drawTrend() {
      const canvas = document.querySelector("#admin-status-trend");
      const empty = document.querySelector("#admin-trend-empty");
      if (!canvas) return;
      const buckets = [8, 10, 12, 14, 16];
      const series = { normal: [], abnormal: [], empty: [] };
      let recordCount = 0;
      buckets.forEach((hour) => {
        const counts = { normal: 0, abnormal: 0, empty: 0 };
        this.data.classStudents.forEach((student) => {
          const records = (this.data.histories.get(student.student_id) || []).filter((item) => {
            const recordHour = new Date(number(item.timestamp_ms)).getHours();
            return recordHour >= hour && recordHour < hour + 2;
          });
          const latest = records.at(-1);
          if (!latest) return;
          recordCount += 1;
          if (latest.posture === "normal") counts.normal += 1;
          else if (latest.posture === "empty") counts.empty += 1;
          else if (["left_lean", "right_lean", "front_lean", "back_lean"].includes(latest.posture)) counts.abnormal += 1;
        });
        Object.keys(series).forEach((key) => series[key].push(counts[key]));
      });
      if (!recordCount) {
        canvas.classList.add("hidden");
        empty.classList.remove("hidden");
        empty.textContent = "今日尚无可聚合的班级历史遥测记录。";
        return;
      }
      canvas.classList.remove("hidden");
      empty.classList.add("hidden");
      const width = Math.max(520, canvas.clientWidth || 760);
      const height = 240;
      const dpr = Math.min(2, global.devicePixelRatio || 1);
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      const ctx = canvas.getContext("2d");
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, width, height);
      const pad = { left: 34, right: 18, top: 22, bottom: 38 };
      const max = Math.max(1, ...Object.values(series).flat());
      ctx.strokeStyle = "rgba(111, 213, 225, .14)";
      ctx.fillStyle = "#7fa6b4";
      ctx.font = "12px system-ui";
      for (let line = 0; line <= 4; line += 1) {
        const y = pad.top + (height - pad.top - pad.bottom) * line / 4;
        ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(width - pad.right, y); ctx.stroke();
      }
      buckets.forEach((hour, index) => {
        const x = pad.left + (width - pad.left - pad.right) * index / (buckets.length - 1);
        ctx.fillText(`${String(hour).padStart(2, "0")}:00`, x - 16, height - 14);
      });
      const configs = [
        ["normal", "#39ffb6"], ["abnormal", "#ffbf69"], ["empty", "#6fa9bc"],
      ];
      configs.forEach(([key, color]) => {
        ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 3; ctx.beginPath();
        series[key].forEach((value, index) => {
          const x = pad.left + (width - pad.left - pad.right) * index / (buckets.length - 1);
          const y = height - pad.bottom - value / max * (height - pad.top - pad.bottom);
          if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.stroke();
        series[key].forEach((value, index) => {
          const x = pad.left + (width - pad.left - pad.right) * index / (buckets.length - 1);
          const y = height - pad.bottom - value / max * (height - pad.top - pad.bottom);
          ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
        });
      });
    }

    renderRiskCenter() {
      const metrics = document.querySelector("#admin-risk-metrics");
      if (!metrics) return;
      const counts = { green: 0, yellow: 0, red: 0 };
      this.data.risks.forEach((item) => { if (counts[item.risk_level] !== undefined) counts[item.risk_level] += 1; });
      metrics.innerHTML = [
        ["绿色风险", `${counts.green} 人`, "当前风险较低", "risk-green"],
        ["黄色风险", `${counts.yellow} 人`, "建议持续关注", "risk-yellow"],
        ["红色风险", `${counts.red} 人`, "需优先查看", "risk-red"],
        ["已评估学生", `${this.data.risks.length} 人`, `学生档案共 ${this.data.overview.student_count || 0} 人`, ""],
      ].map(([label, value, note, cls]) => `<article class="metric-card"><span>${label}</span><strong class="${cls}">${value}</strong><small>${note}</small></article>`).join("");
      const changeGrid = document.querySelector("#admin-risk-change-grid");
      const changeNote = document.querySelector("#admin-risk-change-note");
      const changeBadge = document.querySelector("#admin-risk-change-badge");
      if (changeGrid && this.api.mode === "mock") {
        const newRisks = this.data.risks.filter((item) => item.trend === "new").length;
        const improved = this.data.risks.filter((item) => item.trend === "down").length;
        const persistent = this.data.risks.filter((item) => number(item.consecutive_days) >= 7).length;
        if (changeNote) changeNote.textContent = "根据近期风险评估整理新增、下降和持续关注学生。";
        if (changeBadge) { changeBadge.textContent = "近期动态"; changeBadge.className = "capability-badge ready"; }
        changeGrid.innerHTML = [
          ["今日新增风险", `${newRisks} 人`, "本地演示风险变化"],
          ["风险下降", `${improved} 人`, "较上一模拟周期下降"],
          ["连续一周异常", `${persistent} 人`, "连续风险天数达到 7 天"],
        ].map(([label, value, note]) => `<div><span>${label}</span><strong>${value}</strong><small>${note}</small></div>`).join("");
      }
      this.renderRiskTable();
    }

    renderRiskTable() {
      const target = document.querySelector("#admin-risk-table");
      if (!target) return;
      const query = this.riskSearch.toLowerCase();
      const items = this.data.risks.filter((item) => (this.riskFilter === "all" || item.risk_level === this.riskFilter)
        && `${item.display_code || ""} ${item.student_id} ${item.class_id || ""}`.toLowerCase().includes(query));
      target.innerHTML = `<div class="admin-data-row header risk-row"><span>学生</span><span>风险等级</span><span>风险分数</span><span>主要建议</span><span>连续天数</span><span>操作</span></div>${items.map((item) => {
        const hasDays = item.consecutive_days !== undefined && item.consecutive_days !== null;
        const days = number(item.consecutive_days);
        return `<div class="admin-data-row risk-row"><span><strong>${escapeHtml(item.display_code || item.student_id)}</strong><small>${escapeHtml(item.class_id || "未分班")}</small></span><span><i class="risk-chip ${escapeHtml(item.risk_level)}">${RISK_LABELS[item.risk_level] || item.risk_level}</i></span><span>${number(item.risk_score)}</span><span title="${escapeHtml(item.suggestion || "")}">${escapeHtml(item.suggestion || "暂无特别建议")}</span><span>${hasDays ? (days ? `${days} 天` : "无连续风险") : "--"}<small>${hasDays ? "持续观察" : ""}</small></span><span><button class="ghost small" data-admin-student="${escapeHtml(item.student_id)}" type="button">查看</button></span></div>`;
      }).join("")}${items.length ? "" : `<div class="admin-empty">当前筛选下没有风险记录。</div>`}`;
    }

    deviceStudentMap() {
      const map = new Map();
      this.data.students.forEach((student) => {
        const telemetry = this.data.snapshots.get(student.student_id);
        if (telemetry?.device_id) map.set(telemetry.device_id, student);
      });
      this.data.devices.forEach((device) => {
        if (device.student_id && !map.has(device.device_id)) {
          const student = this.data.students.find((item) => item.student_id === device.student_id);
          if (student) map.set(device.device_id, student);
        }
      });
      return map;
    }

    renderDevices() {
      const metrics = document.querySelector("#admin-device-metrics");
      if (!metrics) return;
      const online = this.data.devices.filter((item) => item.online_status === "online").length;
      const offline = this.data.devices.filter((item) => item.online_status !== "online").length;
      const low = this.data.devices.filter((item) => item.battery_level != null && item.battery_level < 20).length;
      metrics.innerHTML = [["设备总数", this.data.devices.length, "设备档案"], ["在线", online, "当前可接收数据", "risk-green"], ["离线 / 未知", offline, "需检查连接", offline ? "risk-yellow" : ""], ["低电量", low, "电量低于 20%", low ? "risk-red" : ""]].map(([label, value, note, cls = ""]) => `<article class="metric-card"><span>${label}</span><strong class="${cls}">${value}</strong><small>${note}</small></article>`).join("");
      this.renderDeviceTable();
    }

    renderDeviceTable() {
      const target = document.querySelector("#admin-device-table");
      if (!target) return;
      const bindingMap = this.deviceStudentMap();
      const query = this.deviceSearch.toLowerCase();
      const items = this.data.devices.filter((item) => {
        const student = bindingMap.get(item.device_id);
        return `${item.device_id} ${student?.display_code || ""} ${student?.student_id || ""}`.toLowerCase().includes(query);
      });
      target.innerHTML = `<div class="admin-data-row header device-row"><span>设备 ID</span><span>匹配学生</span><span>状态</span><span>电量</span><span>最近上传</span><span>固件</span><span>操作</span></div>${items.map((item) => {
        const student = bindingMap.get(item.device_id);
        return `<div class="admin-data-row device-row"><span><strong>${escapeHtml(item.device_id)}</strong><small>${escapeHtml(item.model_version || "--")}</small></span><span>${student ? `<strong>${escapeHtml(student.display_code || student.student_id)}</strong><small>${escapeHtml(student.student_id)}</small>` : `<span class="muted">暂无可确认归属</span>`}</span><span><i class="device-state ${item.online_status === "online" ? "online" : "offline"}">${item.online_status === "online" ? "在线" : "离线"}</i></span><span class="${item.battery_level != null && item.battery_level < 20 ? "risk-red" : ""}">${item.battery_level == null ? "--" : `${item.battery_level}%`}</span><span>${formatTime(item.last_seen_at)}</span><span>${escapeHtml(item.firmware_version || "--")}</span><span><button class="ghost small" data-admin-device="${escapeHtml(item.device_id)}" type="button">查看</button></span></div>`;
      }).join("")}${items.length ? "" : `<div class="admin-empty">没有匹配的设备。</div>`}`;
    }

    renderReportCenter() {
      const classSelect = document.querySelector("#admin-report-class");
      if (classSelect) {
        classSelect.innerHTML = this.data.classes.map((item) => `<option value="${escapeHtml(item.class_id)}">${escapeHtml(item.class_id || "未分班")} · ${number(item.student_count)} 人</option>`).join("");
        classSelect.value = this.selectedClass;
      }
      ["#admin-export-from", "#admin-export-to"].forEach((selector) => {
        const input = document.querySelector(selector);
        if (input && !input.value) input.value = dateText();
      });
    }

    generateClassReport() {
      const button = document.querySelector("#admin-generate-report");
      const preview = document.querySelector("#admin-report-preview");
      if (!button || !preview) return;
      button.disabled = true;
      button.textContent = "正在整理班级数据…";
      try {
        const students = this.data.classStudents;
        const monitored = students.filter((student) => number(this.data.stats.get(student.student_id)?.total_sitting_s) > 0).length;
        const currentRatio = this.weightedRatio();
        const previousRatio = this.weightedRatio(this.data.previousStats);
        const delta = previousRatio ? (currentRatio - previousRatio) * 100 : 0;
        const trend = !previousRatio ? "暂无昨日对比" : delta >= 2 ? "整体改善" : delta <= -2 ? "需要关注" : "总体稳定";
        const totalSeconds = [...this.data.stats.values()].reduce((sum, item) => sum + number(item?.total_sitting_s), 0);
        const reminders = [...this.data.stats.values()].reduce((sum, item) => sum + number(item?.reminder_count), 0);
        const abnormal = this.abnormalTotals();
        const studentIds = new Set(students.map((student) => student.student_id));
        const risks = this.data.risks.filter((item) => studentIds.has(item.student_id));
        const redRisks = risks.filter((item) => item.risk_level === "red");
        const yellowRisks = risks.filter((item) => item.risk_level === "yellow");
        const priorityNames = [...redRisks, ...yellowRisks]
          .sort((a, b) => number(b.risk_score) - number(a.risk_score))
          .slice(0, 3)
          .map((item) => escapeHtml(item.display_code || item.student_id));
        const summary = this.classSummary();
        const suggestions = [];
        if (redRisks.length) suggestions.push(`优先关注 ${priorityNames.join("、")} 等高风险学生，结合课堂观察安排个别沟通。`);
        if (abnormal.top.label === "前倾") suggestions.push("前倾是当前主要异常，建议检查桌椅高度，并在连续学习 40 分钟后安排短时起身活动。");
        if (["左倾", "右倾"].includes(abnormal.top.label)) suggestions.push("侧倾占比较高，建议提醒学生坐在坐垫中央，并减少长时间单侧支撑。");
        if (currentRatio < .75) suggestions.push("班级标准坐姿率仍有提升空间，可在午后课程前进行一次统一坐姿调整。");
        if (delta < -2) suggestions.push("标准坐姿率较昨日下降，建议重点观察下午时段的疲劳与课堂节奏。");
        if (number(summary.online_device_count) < number(summary.device_count)) suggestions.push("部分坐垫设备未在线，建议课前确认设备连接与供电状态。");
        if (!suggestions.length) suggestions.push("班级整体坐姿表现稳定，继续保持定时活动和温和提醒即可。");
        const abnormalBars = abnormal.items.map((item) => `<div><span>${item.label}</span><b><i style="width:${item.percent}%"></i></b><strong>${item.percent}%</strong></div>`).join("");
        preview.innerHTML = `<header><div><span>今日班级坐姿分析</span><strong>${escapeHtml(this.selectedClass || "未分班")}</strong></div><small>${dateText()} · ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</small></header>
          <div class="admin-report-summary class-report-summary"><div><span>监测学生</span><strong>${monitored} / ${students.length} 人</strong></div><div><span>标准坐姿率</span><strong>${percent(currentRatio)}</strong></div><div><span>较昨日</span><strong class="${delta < 0 ? "risk-yellow" : "risk-green"}">${previousRatio ? `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%` : "--"}</strong></div><div><span>有效监测时长</span><strong>${minutes(totalSeconds)}</strong></div><div><span>提醒次数</span><strong>${reminders} 次</strong></div><div><span>风险学生</span><strong class="${redRisks.length ? "risk-red" : yellowRisks.length ? "risk-yellow" : "risk-green"}">红 ${redRisks.length} · 黄 ${yellowRisks.length}</strong></div></div>
          <div class="class-report-body"><section><span class="class-report-label">群体趋势</span><h3>${trend}</h3><p>今日班级标准坐姿率为 ${percent(currentRatio)}${previousRatio ? `，较昨日${delta >= 0 ? "上升" : "下降"} ${Math.abs(delta).toFixed(1)} 个百分点` : ""}。班级累计有效监测 ${minutes(totalSeconds)}，共产生 ${reminders} 次坐姿提醒。</p><div class="class-report-focus"><span class="class-report-label">重点关注</span><p>${priorityNames.length ? `${priorityNames.join("、")} 的风险评分相对较高，建议结合连续异常时长和课堂表现持续观察。` : "当前没有需要优先干预的高风险学生。"}</p></div></section><section><span class="class-report-label">异常姿态构成</span><div class="class-report-bars">${abnormalBars}</div><p>${abnormal.total ? `${abnormal.top.label}占异常记录 ${abnormal.top.percent}%，是当前最需要关注的姿态。` : "今日暂未发现明显异常姿态记录。"}</p></section></div>
          <section class="class-report-advice"><span class="class-report-label">班主任建议</span><ol>${suggestions.map((item) => `<li>${item}</li>`).join("")}</ol></section>`;
        this.toast("班级坐姿分析报告已生成");
      } catch (error) {
        preview.innerHTML = `<div class="admin-report-welcome"><strong>报告生成失败</strong><span>${escapeHtml(error.message)}</span></div>`;
      } finally {
        button.disabled = false;
        button.textContent = "生成班级报告";
      }
    }

    async exportData(button) {
      const from = document.querySelector("#admin-export-from")?.value || "";
      const to = document.querySelector("#admin-export-to")?.value || "";
      const original = button.textContent;
      button.disabled = true;
      button.textContent = "生成中…";
      try {
        const riskLevel = document.querySelector("#admin-risk-export-level")?.value || "red";
        await this.api.downloadAdminRiskExport({ risk_level: riskLevel, from, to });
        this.toast("风险学生 ZIP 档案已生成");
      } catch (error) {
        global.alert(`导出失败：${error.message}`);
      } finally {
        button.disabled = false;
        button.textContent = original;
      }
    }

    openStudent(studentId) {
      const student = this.data.students.find((item) => item.student_id === studentId)
        || this.data.classStudents.find((item) => item.student_id === studentId);
      if (!student) return;
      const telemetry = this.data.snapshots.get(studentId);
      const stat = this.data.stats.get(studentId) || {};
      const garden = this.data.gardens.get(studentId) || {};
      const risk = this.data.risks.find((item) => item.student_id === studentId);
      const posture = POSTURE_META[this.currentPosture(studentId)];
      this.openDetail(`<p class="eyebrow">学生详情</p><h2 id="admin-detail-title">${escapeHtml(student.display_code || student.student_id)}</h2><p class="admin-detail-subtitle">${escapeHtml(student.class_id || "未分班")} · ${escapeHtml(student.student_id)}</p><div class="admin-detail-metrics"><div><span>当前坐姿</span><strong>${posture.label}</strong></div><div><span>今日标准率</span><strong>${percent(stat.normal_ratio)}</strong></div><div><span>今日有效时长</span><strong>${minutes(stat.total_sitting_s)}</strong></div><div><span>风险评估</span><strong class="risk-${escapeHtml(risk?.risk_level || "unknown")}">${risk ? `${RISK_LABELS[risk.risk_level] || risk.risk_level} · ${number(risk.risk_score)} 分` : "暂无"}</strong></div><div><span>设备</span><strong>${escapeHtml(telemetry?.device_id || "未匹配")}</strong></div><div><span>小树阶段</span><strong>${escapeHtml(garden.stage || "暂无数据")}</strong></div></div><div class="admin-detail-note"><strong>最新建议</strong><p>${escapeHtml(risk?.suggestion || "暂无特别建议。")}</p><small>最近遥测：${telemetry ? formatTime(telemetry.timestamp_ms) : "暂无"}</small></div>`);
    }

    openDevice(deviceId) {
      const device = this.data.devices.find((item) => item.device_id === deviceId);
      if (!device) return;
      const current = this.deviceStudentMap().get(deviceId);
      this.openDetail(`<p class="eyebrow">设备详情</p><h2 id="admin-detail-title">${escapeHtml(device.device_id)}</h2><p class="admin-detail-subtitle">${device.online_status === "online" ? "在线" : "离线"} · 最近上传 ${formatTime(device.last_seen_at)}</p><div class="admin-detail-metrics"><div><span>电量</span><strong>${device.battery_level == null ? "--" : `${device.battery_level}%`}</strong></div><div><span>固件</span><strong>${escapeHtml(device.firmware_version || "--")}</strong></div><div><span>模型</span><strong>${escapeHtml(device.model_version || "--")}</strong></div><div><span>当前可确认学生</span><strong>${escapeHtml(current?.display_code || "暂无")}</strong></div></div><form id="admin-bind-form" class="admin-bind-form" data-device-id="${escapeHtml(deviceId)}"><label><span>绑定 / 更换学生</span><select name="student_id">${this.data.students.map((student) => `<option value="${escapeHtml(student.student_id)}" ${student.student_id === current?.student_id ? "selected" : ""}>${escapeHtml(student.display_code || student.student_id)} · ${escapeHtml(student.class_id || "未分班")}</option>`).join("")}</select></label><button class="primary" type="submit">保存绑定</button></form><div class="admin-disabled-actions"><button disabled title="后端未提供解除绑定接口" type="button">解除绑定</button><button disabled title="后端未提供维修状态字段" type="button">标记维修</button></div><p class="admin-api-note">设备列表不返回绑定关系；当前学生是根据最新遥测匹配的。</p>`);
    }

    openAllStudents() {
      this.openDetail(`<p class="eyebrow">学生管理</p><h2 id="admin-detail-title">${escapeHtml(this.selectedClass)}学生名单</h2><div class="admin-student-list">${this.data.classStudents.map((student) => `<button data-admin-student="${escapeHtml(student.student_id)}" type="button"><span><strong>${escapeHtml(student.display_code || student.student_id)}</strong><small>${escapeHtml(student.student_id)}</small></span><em>${POSTURE_META[this.currentPosture(student.student_id)].short}</em></button>`).join("") || `<div class="admin-empty">暂无学生。</div>`}</div>`);
    }

    openDetail(content) {
      const modal = document.querySelector("#admin-detail-modal");
      const target = document.querySelector("#admin-detail-content");
      if (!modal || !target) return;
      target.innerHTML = content;
      modal.classList.remove("hidden");
      document.body.classList.add("admin-modal-open");
    }

    closeDetail() {
      document.querySelector("#admin-detail-modal")?.classList.add("hidden");
      document.body.classList.remove("admin-modal-open");
    }

    async bindDevice(form) {
      const deviceId = form.dataset.deviceId;
      const studentId = new FormData(form).get("student_id");
      const button = form.querySelector("button");
      button.disabled = true;
      try {
        await this.api.bindDevice({ device_id: deviceId, student_id: studentId });
        this.toast("设备绑定已更新");
        this.closeDetail();
        await this.load(true);
      } catch (error) {
        global.alert(`绑定失败：${error.message}`);
      } finally { button.disabled = false; }
    }

    initEvents() {
      if (this.eventsReady) return;
      this.eventsReady = true;
      document.addEventListener("click", (event) => {
        const nav = event.target.closest("[data-admin-nav]");
        if (nav) document.querySelector(`[data-nav="${nav.dataset.adminNav}"]`)?.click();
        const student = event.target.closest("[data-admin-student]");
        if (student) this.openStudent(student.dataset.adminStudent);
        const device = event.target.closest("[data-admin-device]");
        if (device) this.openDevice(device.dataset.adminDevice);
        const risk = event.target.closest("[data-risk-filter]");
        if (risk) {
          this.riskFilter = risk.dataset.riskFilter;
          document.querySelectorAll("[data-risk-filter]").forEach((button) => button.classList.toggle("active", button === risk));
          this.renderRiskTable();
        }
        const posture = event.target.closest("[data-posture-filter]");
        if (posture) {
          this.postureFilter = this.postureFilter === posture.dataset.postureFilter ? "all" : posture.dataset.postureFilter;
          this.renderComposition(); this.renderForest();
        }
        const ranking = event.target.closest("[data-admin-ranking]");
        if (ranking) {
          this.rankingMode = ranking.dataset.adminRanking;
          document.querySelectorAll("[data-admin-ranking]").forEach((button) => button.classList.toggle("active", button === ranking));
          this.renderRanking();
        }
        const action = event.target.closest("[data-admin-action]")?.dataset.adminAction;
        if (action === "close-detail") this.closeDetail();
        if (action === "show-all-students") this.openAllStudents();
        const exportButton = event.target.closest("[data-admin-export]");
        if (exportButton) this.exportData(exportButton);
      });
      document.querySelector("#admin-class-select")?.addEventListener("change", async (event) => {
        this.selectedClass = event.target.value;
        this.data.weekly.clear();
        this.postureFilter = "all";
        localStorage.setItem("sg.admin.class", this.selectedClass);
        await this.load(true);
      });
      document.querySelector("#admin-risk-search")?.addEventListener("input", (event) => { this.riskSearch = event.target.value; this.renderRiskTable(); });
      document.querySelector("#admin-device-search")?.addEventListener("input", (event) => { this.deviceSearch = event.target.value; this.renderDeviceTable(); });
      document.querySelector("#admin-report-class")?.addEventListener("change", async (event) => {
        this.selectedClass = event.target.value;
        this.data.weekly.clear();
        this.postureFilter = "all";
        localStorage.setItem("sg.admin.class", this.selectedClass);
        const primarySelect = document.querySelector("#admin-class-select");
        if (primarySelect) primarySelect.value = this.selectedClass;
        await this.load(true);
      });
      document.querySelector("#admin-generate-report")?.addEventListener("click", () => this.generateClassReport());
      document.querySelector("#admin-detail-modal")?.addEventListener("click", (event) => { if (event.target.id === "admin-detail-modal") this.closeDetail(); });
      document.addEventListener("submit", (event) => {
        if (event.target.id !== "admin-bind-form") return;
        event.preventDefault();
        this.bindDevice(event.target);
      });
      global.addEventListener("resize", () => requestAnimationFrame(() => this.drawTrend()));
    }

    setLiveStatus(text, loading = false, failed = false) {
      const target = document.querySelector("#admin-live-status");
      if (!target) return;
      target.textContent = text;
      target.title = failed ? text : "";
      target.classList.toggle("loading", loading);
      target.classList.toggle("failed", failed);
    }

    renderError() {
      const metrics = document.querySelector("#dashboard-metrics");
      if (metrics) metrics.replaceChildren();
    }
  }

  global.SpineGuardAdminWorkspace = AdminWorkspace;
})(window);
