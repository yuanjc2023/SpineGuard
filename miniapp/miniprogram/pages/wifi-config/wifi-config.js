Page({
  data: {
    wifiConfigUrl: 'http://192.168.4.1'
  },

  onWebViewError() {
    wx.showModal({
      title: '配网页无法访问',
      content: '请先在手机系统设置中连接设备 Wi-Fi 热点，再访问 192.168.4.1。若微信仍然拦截，请使用系统浏览器打开该地址。',
      confirmText: '复制地址',
      cancelText: '返回',
      success: (result) => {
        if (result.confirm) {
          wx.setClipboardData({ data: this.data.wifiConfigUrl });
        }
      }
    });
  }
});
