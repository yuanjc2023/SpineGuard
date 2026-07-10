const labels={empty:"无人",normal:"正常坐姿",left_lean:"左倾",right_lean:"右倾",front_lean:"前倾",back_lean:"后倾"};
Page({
  data:{posture:"等待数据",confidence:0,pressure:{left:0,right:0,front:0,back:0,center:0},connected:false},
  onLoad(){this.refresh();this.timer=setInterval(()=>this.refresh(),1000)},
  onUnload(){clearInterval(this.timer)},
  refresh(){
    const app=getApp();
    wx.request({
      url:`${app.globalData.apiBase}/devices/${app.globalData.deviceId}/latest`,
      success:r=>{const f=r.data.data;if(f)this.setData({posture:labels[f.posture]||"未知",confidence:Math.round(f.confidence*100),pressure:f.pressure,connected:true})},
      fail:()=>this.setData({connected:false})
    })
  }
});
