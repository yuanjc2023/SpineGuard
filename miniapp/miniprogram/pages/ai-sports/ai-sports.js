const aiAssistant = require('../../services/aiAssistant');

Page({
  data: {
    date: '',
    summaryText: '正在读取今日坐姿数据…',
    summarySource: '分析中',
    summaryLoading: true,
    canChat: false,
    inputValue: '',
    sending: false,
    scrollIntoView: '',
    quickQuestions: ['我今天坐姿怎么样？', '压力分布均衡吗？', '给我一个放松建议'],
    messages: [
      {
        id: 'welcome',
        role: 'assistant',
        text: '你好，我可以结合今天的坐姿时长、压力分布和提醒数据回答问题。'
      }
    ]
  },

  onLoad() {
    const date = this.formatDate(new Date());
    const student = wx.getStorageSync('currentStudent') || {};
    this.studentId = student.student_id || '';
    this.setData({ date, canChat: Boolean(this.studentId && wx.getStorageSync('accessToken')) });
    if (!this.data.canChat) {
      this.setData({
        summaryLoading: false,
        summarySource: '未连接',
        summaryText: '请先退出体验模式并登录后端账号，AI 助手才能读取坐姿数据。'
      });
      return;
    }
    this.loadDailySummary();
  },

  loadDailySummary() {
    this.setData({ summaryLoading: true, summarySource: '生成中' });
    aiAssistant.generateDailyReport(this.studentId, this.data.date).then((report) => {
      this.setData({
        summaryText: this.buildSummary(report),
        summarySource: report.generated_by === 'llm' ? 'AI 分析' : '数据分析',
        summaryLoading: false
      });
    }).catch((error) => {
      console.error('生成今日坐姿分析失败', error);
      this.setData({
        summaryText: '暂时无法生成今日分析，请确认后端与坐垫数据已连接。',
        summarySource: '连接失败',
        summaryLoading: false
      });
    });
  },

  buildSummary(report) {
    const summary = report.summary || {};
    const risk = summary.risk || {};
    const totalSeconds = (summary.normal_sitting_s || 0) + (summary.poor_sitting_s || 0);
    if (!totalSeconds) return '今天暂未收到足够的坐姿记录，连接坐垫并使用一段时间后再来看看。';
    const normalPercent = Math.round((summary.normal_sitting_s || 0) / totalSeconds * 100);
    const poorMinutes = Math.round((summary.poor_sitting_s || 0) / 60);
    const reminderCount = summary.reminder_count || 0;
    const suggestion = risk.suggestion || '继续保持双脚平放，并定时起身活动。';
    return `标准坐姿占比 ${normalPercent}%，非标准坐姿约 ${poorMinutes} 分钟，提醒 ${reminderCount} 次。${suggestion}`;
  },

  onInput(e) {
    this.setData({ inputValue: e.detail.value });
  },

  useQuickQuestion(e) {
    if (!this.data.canChat || this.data.sending) return;
    this.setData({ inputValue: e.currentTarget.dataset.question }, () => this.sendMessage());
  },

  sendMessage() {
    const text = this.data.inputValue.trim();
    if (!text || this.data.sending || !this.data.canChat) return;
    const userMessage = { id: `user-${Date.now()}`, role: 'user', text };
    const history = this.data.messages.filter((item) => item.id !== 'welcome');
    this.setData({
      messages: this.data.messages.concat(userMessage),
      inputValue: '',
      sending: true,
      scrollIntoView: userMessage.id
    });

    aiAssistant.chat(this.studentId, text, this.data.date, history).then((result) => {
      const assistantMessage = {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        text: result.reply,
        source: String(result.generated_by || '').indexOf('llm') === 0 ? 'AI 报告' : '数据规则'
      };
      this.setData({
        messages: this.data.messages.concat(assistantMessage),
        sending: false,
        scrollIntoView: assistantMessage.id
      });
    }).catch((error) => {
      console.error('AI 助手请求失败', error);
      const errorMessage = {
        id: `error-${Date.now()}`,
        role: 'assistant',
        text: '暂时无法连接 AI 助手，请检查后端服务后再试。'
      };
      this.setData({
        messages: this.data.messages.concat(errorMessage),
        sending: false,
        scrollIntoView: errorMessage.id
      });
    });
  },

  formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
});
