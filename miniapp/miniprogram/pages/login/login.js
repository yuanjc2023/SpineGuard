const authService = require('../../services/auth');

Page({
  data: {
    username: 'parent_demo',
    password: 'parent123'
  },

  onLoad() {
    const token = wx.getStorageSync('accessToken');
    const dataMode = wx.getStorageSync('dataMode');
    if (token || dataMode === 'mock') wx.switchTab({ url: '/pages/monitor/monitor' });
  },

  onUsernameInput(e) {
    this.setData({ username: e.detail.value });
  },

  onPasswordInput(e) {
    this.setData({ password: e.detail.value });
  },

  doLogin() {
    const username = this.data.username.trim();
    const password = this.data.password;
    if (!username || !password) {
      wx.showToast({ title: '请输入账号和密码', icon: 'none' });
      return;
    }
    wx.showLoading({ title: '连接后端...' });
    authService.login(username, password).then((context) => {
      wx.hideLoading();
      const suffix = context.device ? '' : '，但账号尚未绑定设备';
      wx.showToast({ title: `登录成功${suffix}`, icon: context.device ? 'success' : 'none', duration: 1800 });
      setTimeout(() => wx.switchTab({ url: '/pages/monitor/monitor' }), context.device ? 300 : 1200);
    }).catch((error) => {
      wx.hideLoading();
      authService.logout();
      wx.showModal({
        title: '后端连接失败',
        content: error.message || '请确认 FastAPI 已启动且账号正确',
        showCancel: false
      });
    });
  },

  useDemoDevice() {
    authService.logout();
    wx.setStorageSync('dataMode', 'mock');
    wx.setStorageSync('boundDevice', {
      deviceCode: 'SG-0001',
      nickName: '体验设备',
      bindTime: '本地 Mock'
    });
    wx.showToast({ title: '已进入体验模式', icon: 'success' });
    wx.switchTab({ url: '/pages/monitor/monitor' });
  }
});
