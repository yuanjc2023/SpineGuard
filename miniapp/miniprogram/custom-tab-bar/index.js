Component({
  data: {
    selected: 0,
    list: [
      { pagePath: "/pages/monitor/monitor", text: "监测", iconPath: "/images/tab/monitor.png", selectedIconPath: "/images/tab/monitor-active.png" },
      { pagePath: "/pages/data/data", text: "数据", iconPath: "/images/tab/data.png", selectedIconPath: "/images/tab/data-active.png" },
      { pagePath: "/pages/game/game", text: "乐园", iconPath: "/images/tab/garden.png", selectedIconPath: "/images/tab/garden-active.png" },
      { pagePath: "/pages/profile/profile", text: "我的", iconPath: "/images/tab/profile.png", selectedIconPath: "/images/tab/profile-active.png" }
    ]
  },
  methods: {
    switchTab(e) {
      const index = e.currentTarget.dataset.index;
      const path = e.currentTarget.dataset.path;
      this.setData({ selected: index });
      wx.switchTab({ url: path });
    }
  }
});
