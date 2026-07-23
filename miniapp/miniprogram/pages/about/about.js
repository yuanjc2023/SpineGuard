Page({
  data: {
    productName: '脊小树',
    version: 'v1.0.0',
    privacyUrl: 'https://example.com/privacy',
    serviceEmail: 'support@jixiaoshu.example',
    serviceWechat: 'JiXiaoShuService'
  },

  copyPrivacy() {
    wx.setClipboardData({
      data: this.data.privacyUrl,
      success: () => wx.showToast({ title: '链接已复制', icon: 'success' })
    });
  },

  copyEmail() {
    wx.setClipboardData({
      data: this.data.serviceEmail,
      success: () => wx.showToast({ title: '邮箱已复制', icon: 'success' })
    });
  },

  copyWechat() {
    wx.setClipboardData({
      data: this.data.serviceWechat,
      success: () => wx.showToast({ title: '微信已复制', icon: 'success' })
    });
  }
});
