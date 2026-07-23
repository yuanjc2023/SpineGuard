const labels={empty:"无人",normal:"正常坐姿",left_lean:"左倾",right_lean:"右倾",front_lean:"前倾",back_lean:"后倾"};
Page({
  data:{
    posture:"等待数据",confidence:0,
    pressure:{left:0,right:0,front:0,back:0,center:0},
    pressureFeatures:{total_pressure:0,left_right_diff:0,front_back_diff:0,center_x:0,center_y:0,asymmetry_index:0},
    backrest:null,vibrationActive:false,vibrationPosition:null,sensorStatus:null,
    reminderCount:0,batteryLevel:null,connected:false
  },
  onLoad(){this.refresh();this.timer=setInterval(()=>this.refresh(),1000)},
  onUnload(){clearInterval(this.timer)},
  refresh(){
    const app=getApp();
    wx.request({
      url:`${app.globalData.apiBase}/devices/${app.globalData.deviceId}/latest`,
      success:r=>{const f=r.data.data;if(f)this.setData({
        posture:labels[f.posture]||"未知",
        confidence:Math.round(f.confidence*100),
        pressure:f.pressure,
        pressureFeatures:f.pressure_features,
        backrest:f.backrest||null,
        vibrationActive:!!f.vibration_active,
        vibrationPosition:f.vibration_position||null,
        sensorStatus:f.sensor_status||null,
        reminderCount:f.reminder_count,
        batteryLevel:f.battery_level==null?null:f.battery_level,
        connected:true
      })},
      fail:()=>this.setData({connected:false})
    })
  }
});
