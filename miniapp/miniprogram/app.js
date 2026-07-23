App({
  onLaunch() {
    this.globalData = {
      env: 'cloud1-d9g2c4cucc9ffa585'
    };
    if (wx.cloud) {
      wx.cloud.init({
        env: this.globalData.env,
        traceUser: true
      });
    }
    // 旧版本使用 backend 作为模式名；统一迁移为 api。
    if (wx.getStorageSync('dataMode') === 'backend') wx.setStorageSync('dataMode', 'api');
    // v1 乐园缓存含已废弃字段，升级后整体清除，正式状态由服务层重建。
    wx.removeStorageSync('spineTreeGardenState');
  }
});
