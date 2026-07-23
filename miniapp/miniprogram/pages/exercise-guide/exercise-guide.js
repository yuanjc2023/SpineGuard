const exerciseGuide = require('../../services/exerciseGuide');

const postureNames = { normal: '标准', left_lean: '左倾', right_lean: '右倾', front_lean: '前倾', back_lean: '后倾' };
const FOLLOW_ALONG_VIDEO = {
  title: '预防脊柱侧弯形体操',
  source: '哔哩哔哩',
  bvid: 'BV1nrctekEhf',
  url: 'https://www.bilibili.com/video/BV1nrctekEhf/'
};

Page({
  data: {
    loading: true, errorMessage: '', context: null, reasons: [], recommendations: [],
    selected: exerciseGuide.catalog[0], categories: ['全部'].concat(exerciseGuide.categories), activeCategory: '全部', library: exerciseGuide.catalog,
    metrics: [], aiText: '推荐由透明规则生成。可按需调用现有AI助手解释，不参与动作完成判定。', aiLoading: false,
    recent: [], planDays: [], guideActive: false, guideRunning: false, guideIds: [], guideIndex: 0,
    guideItem: exerciseGuide.catalog[0], guideRemaining: 0, guideClock: '00:00', guideProgress: 0, guideStep: '', gardenFeedback: false,
    followAlongVideo: FOLLOW_ALONG_VIDEO
  },

  onLoad() {
    const draft = exerciseGuide.loadDraft();
    if (draft && draft.ids && draft.ids.length) {
      wx.showModal({
        title: '恢复上次引导', content: '上次动作引导尚未结束，是否从保存位置继续？',
        success: (res) => { if (res.confirm) this.restoreGuide(draft); else exerciseGuide.saveDraft(null); }
      });
    }
  },

  onShow() { this.loadData(); this.refreshLocal(); if (this.data.guideActive && this.data.guideRunning) this.startTimer(); },
  onHide() { this.pauseAndSaveGuide(); },
  onUnload() { this.pauseAndSaveGuide(); },
  onPullDownRefresh() { this.loadData().finally(() => wx.stopPullDownRefresh()); },

  loadData() {
    this.setData({ loading: true, errorMessage: '' });
    return exerciseGuide.loadContext().then((context) => {
      const selected = context.recommended[0] || exerciseGuide.catalog[0];
      this.setData({
        loading: false, context, reasons: context.reasons, recommendations: context.recommended, selected,
        metrics: [
          { label: '标准采样', value: `${context.percentages.normal || 0}%` },
          { label: '主要偏差', value: postureNames[context.dominantCode] || '待识别' },
          { label: '有效就坐', value: `${Math.round(context.sittingSeconds / 60)}分钟` },
          { label: '压力偏差', value: `${Math.round(context.asymmetry * 100)}%` },
          { label: '今日提醒', value: `${context.reminderCount}次` }
        ],
        aiText: `${context.reasons.join('；')}。因此优先推荐${context.recommended.map((item) => item.name).join('、')}。这是规则推荐，不是医学诊断。`
      });
    }).catch((error) => this.setData({ loading: false, errorMessage: `坐姿数据读取失败：${error.message}` }));
  },

  refreshLocal() {
    const local = exerciseGuide.loadLocal();
    const recent = [].concat(
      (local.recentGuides || []).map((item) => Object.assign({}, item, { type: '最近引导' })),
      (local.recentViews || []).map((item) => Object.assign({}, item, { type: '最近查看' }))
    ).sort((a,b) => Date.parse(b.at) - Date.parse(a.at)).slice(0,6).map((entry) => ({
      id: entry.ids[0], type: entry.type, names: entry.ids.map((id) => exerciseGuide.getById(id).name).join('、'), time: new Date(entry.at).toLocaleString('zh-CN', { hour12: false })
    }));
    this.setData({ recent, planDays: exerciseGuide.sevenDayPlan() });
  },

  selectExercise(e) {
    const id = e.currentTarget.dataset.id; const selected = exerciseGuide.getById(id);
    exerciseGuide.recordView(id); this.setData({ selected }); this.refreshLocal();
  },
  selectCategory(e) {
    const category = e.currentTarget.dataset.category;
    this.setData({ activeCategory: category, library: category === '全部' ? exerciseGuide.catalog : exerciseGuide.catalog.filter((item) => item.category === category) });
  },
  getAiExplain() {
    if (!this.data.context || this.data.aiLoading) return;
    this.setData({ aiLoading: true, aiText: '正在调用现有AI助手解释推荐依据…' });
    exerciseGuide.aiExplain(this.data.context).then((result) => this.setData({ aiText: `${result.reply}（来源：${result.source}）` }))
      .catch((error) => this.setData({ aiText: `AI解释暂不可用：${error.message}。仍可使用规则推荐。` }))
      .finally(() => this.setData({ aiLoading: false }));
  },

  startSelected() { this.beginGuide([this.data.selected.id]); },
  startRecommended() { this.beginGuide((this.data.recommendations || []).map((item) => item.id)); },
  beginGuide(ids) {
    if (!ids.length) return;
    this.setData({ guideActive: true, guideRunning: true, guideIds: ids, guideIndex: 0, gardenFeedback: false }, () => { this.setGuideIndex(0); this.startTimer(); });
  },
  restoreGuide(draft) {
    this.setData({ guideActive: true, guideRunning: false, guideIds: draft.ids, guideIndex: draft.index || 0, gardenFeedback: false }, () => {
      const item = exerciseGuide.getById(draft.ids[draft.index || 0]);
      this.setData({ guideItem: item, guideRemaining: Math.max(1, Number(draft.remaining) || item.durationSeconds) }, () => this.updateGuideDisplay());
    });
  },
  setGuideIndex(index) {
    const safe = Math.max(0, Math.min(index, this.data.guideIds.length - 1)); const item = exerciseGuide.getById(this.data.guideIds[safe]);
    this.setData({ guideIndex: safe, guideItem: item, guideRemaining: item.durationSeconds }, () => this.updateGuideDisplay());
  },
  updateGuideDisplay() {
    const total = this.data.guideItem.durationSeconds; const elapsed = total - this.data.guideRemaining;
    const stepIndex = Math.min(this.data.guideItem.steps.length - 1, Math.floor(elapsed / Math.max(1, total / this.data.guideItem.steps.length)));
    const seconds = Math.max(0, Math.floor(this.data.guideRemaining));
    this.setData({ guideClock: `${String(Math.floor(seconds / 60)).padStart(2,'0')}:${String(seconds % 60).padStart(2,'0')}`, guideProgress: Math.max(0, Math.round(elapsed / total * 100)), guideStep: this.data.guideItem.steps[stepIndex] });
  },
  startTimer() {
    clearInterval(this.guideTimer);
    this.guideTimer = setInterval(() => {
      if (!this.data.guideActive || !this.data.guideRunning) return;
      const remaining = this.data.guideRemaining - 1;
      if (remaining <= 0) this.nextGuide(); else this.setData({ guideRemaining: remaining }, () => this.updateGuideDisplay());
    }, 1000);
  },
  toggleGuide() { this.setData({ guideRunning: !this.data.guideRunning }, () => { if (this.data.guideRunning) this.startTimer(); else this.pauseAndSaveGuide(); }); },
  previousGuide() { if (this.data.guideIndex > 0) this.setGuideIndex(this.data.guideIndex - 1); },
  nextGuide() { if (this.data.guideIndex >= this.data.guideIds.length - 1) this.finishGuide(); else this.setGuideIndex(this.data.guideIndex + 1); },
  pauseAndSaveGuide() {
    clearInterval(this.guideTimer); this.guideTimer = null;
    if (!this.data.guideActive) return;
    this.setData({ guideRunning: false });
    exerciseGuide.saveDraft({ ids: this.data.guideIds, index: this.data.guideIndex, remaining: this.data.guideRemaining, savedAt: Date.now() });
  },
  closeGuide() { clearInterval(this.guideTimer); this.guideTimer = null; exerciseGuide.saveDraft(null); this.setData({ guideActive: false, guideRunning: false }); },
  finishGuide() {
    clearInterval(this.guideTimer); this.guideTimer = null; exerciseGuide.saveDraft(null); exerciseGuide.recordGuide(this.data.guideIds);
    this.setData({ guideActive: false, guideRunning: false, gardenFeedback: true }); this.refreshLocal();
    wx.showModal({ title: '本次护脊引导结束', content: '已完成动作学习。没有判定正式任务，也没有发放资源或成长值。', showCancel: false });
  },
  openFollowAlongVideo() {
    const video = this.data.followAlongVideo;
    wx.setClipboardData({
      data: video.url,
      success: () => {
        wx.showModal({
          title: '跟练链接已复制',
          content: `请打开哔哩哔哩，粘贴链接后播放《${video.title}》。练习时请预留安全空间，如有疼痛或不适请立即停止。`,
          showCancel: false,
          confirmText: '知道了'
        });
      },
      fail: () => wx.showModal({
        title: '无法复制链接',
        content: video.url,
        showCancel: false
      })
    });
  },
  closeGardenFeedback() { this.setData({ gardenFeedback: false }); }
});
