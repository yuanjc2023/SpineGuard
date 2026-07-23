Page({
  data: {
    activeFaq: 0,
    feedbackContent: '',
    contact: '',
    submitting: false,
    faqs: [
      {
        question: '设备放在哪里最准确？',
        answer: '请将坐姿垫放在椅面正中，孩子坐下后等待 3 秒，系统会自动同步压力分布。'
      },
      {
        question: '为什么会出现前倾提醒？',
        answer: '当前倾姿势持续一段时间，压力重心会前移，系统会给出提醒，建议调整桌椅高度。'
      },
      {
        question: '数据没有更新怎么办？',
        answer: '请检查网络和设备电量，再回到监测页点击手动刷新；仍异常时可尝试重新绑定设备。'
      }
    ]
  },

  toggleFaq(e) {
    const index = Number(e.currentTarget.dataset.index);
    this.setData({ activeFaq: this.data.activeFaq === index ? -1 : index });
  },

  onContentInput(e) {
    this.setData({ feedbackContent: e.detail.value });
  },

  onContactInput(e) {
    this.setData({ contact: e.detail.value });
  },

  submitFeedback() {
    const content = this.data.feedbackContent.trim();
    if (!content) {
      wx.showToast({ title: '请填写反馈内容', icon: 'none' });
      return;
    }

    if (wx.getStorageSync('dataMode') !== 'mock') {
      wx.showModal({ title: '暂不能提交', content: '后端尚未提供用户反馈接口，请在接口实现后重试。', showCancel: false });
      return;
    }
    const payload = {
      content,
      contact: this.data.contact.trim(),
      createTime: new Date()
    };
    const localFeedback = wx.getStorageSync('feedbackList') || [];
    wx.setStorageSync('feedbackList', [payload].concat(localFeedback));

    this.setData({ submitting: true });
    this.afterSubmit();
  },

  afterSubmit() {
    this.setData({
      submitting: false,
      feedbackContent: '',
      contact: ''
    });
    wx.showToast({ title: '提交成功', icon: 'success' });
  }
});
