// pages/profile/profile.js
const authService = require('../../services/auth');
const reportNotifications = require('../../services/reportNotifications');

Page({
  data: {
    userInfo: {
      nickName: '家长'
    },
    deviceCode: '未绑定',
    accountActionText: '退出后端账号',
    unreadReportCount: 0,
    unreadReportText: ''
  },
  onLoad() {
    this.loadProfile();
  },
  loadProfile() {
    const boundDevice = wx.getStorageSync('boundDevice');
    const currentUser = wx.getStorageSync('currentUser');
    this.setData({
      deviceCode: boundDevice && boundDevice.deviceCode ? boundDevice.deviceCode : '未绑定',
      'userInfo.nickName': currentUser && currentUser.username ? currentUser.username : '家长',
      accountActionText: wx.getStorageSync('dataMode') === 'mock' ? '退出体验模式' : '退出后端账号'
    });
  },
  onShow() {
    this.loadProfile();
    if (wx.getStorageSync('dataMode') !== 'mock' && wx.getStorageSync('accessToken')) {
      authService.bootstrapUserContext().catch((error) => {
        console.error('同步个人中心绑定设备失败', error);
      }).then(() => {
        this.loadProfile();
        this.loadUnreadReportCount();
      });
    } else {
      this.setData({ unreadReportCount: 0, unreadReportText: '' });
    }
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 3 });
    }
  },
  loadUnreadReportCount() {
    const student = wx.getStorageSync('currentStudent') || {};
    if (!student.student_id || !wx.getStorageSync('accessToken')) {
      this.setData({ unreadReportCount: 0, unreadReportText: '' });
      return Promise.resolve();
    }
    return reportNotifications.getUnreadReportCount(student.student_id).then((count) => {
      this.setData({
        unreadReportCount: count,
        unreadReportText: count > 99 ? '99+' : String(count)
      });
    }).catch((error) => {
      console.warn('未读报告数同步失败', error);
    });
  },
  unbindDevice() {
    wx.showModal({
      title: '提示',
      content: '确定退出当前账号吗？这不会解除后端中的设备绑定关系。',
      success: (res) => {
        if (res.confirm) {
          authService.logout();
          wx.removeStorageSync('dataMode');
          wx.reLaunch({ url: '/pages/login/login' });
        }
      }
    });
  },
  goToDeviceManage() {
    wx.navigateTo({ url: '/pages/device-manage/device-manage' });
  },
  goToChildInfo() {
    wx.navigateTo({ url: '/pages/child-info/child-info' });
  },
  goToAISports() {
    wx.navigateTo({ url: '/pages/ai-sports/ai-sports' });
  },
  goToExerciseGuide() {
    wx.navigateTo({ url: '/pages/exercise-guide/exercise-guide' });
  },
  goToReportCenter() {
    wx.navigateTo({ url: '/pages/report-center/report-center' });
  },
  goToHelp() {
    wx.navigateTo({ url: '/pages/help-feedback/help-feedback' });
  },
  goToAbout() {
    wx.navigateTo({ url: '/pages/about/about' });
  }
});
