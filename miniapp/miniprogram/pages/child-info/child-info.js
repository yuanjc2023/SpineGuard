Page({
  data: {
    form: {
      name: '',
      gender: '男',
      grade: '3',
      className: ''
    },
    genderOptions: ['男', '女'],
    gradeOptions: ['1', '2', '3', '4', '5', '6', '7', '8', '9'],
    genderIndex: 0,
    gradeIndex: 2,
    saving: false
  },

  onLoad() {
    this.loadChildInfo();
  },

  loadChildInfo() {
    const student = wx.getStorageSync('currentStudent') || {};
    const cached = wx.getStorageSync('childInfo');
    if (wx.getStorageSync('dataMode') === 'mock' && cached && cached.name) {
      this.applyForm(cached);
      return;
    }
    if (student.student_id) this.applyForm({ name: student.display_code, className: student.class_id || '' });
  },

  applyForm(data) {
    const genderIndex = this.data.genderOptions.indexOf(data.gender);
    const gradeIndex = this.data.gradeOptions.indexOf(`${data.grade}`);
    this.setData({
      form: {
        name: data.name || '',
        gender: data.gender || '男',
        grade: `${data.grade || '3'}`,
        className: data.className || data.class || ''
      },
      genderIndex: genderIndex >= 0 ? genderIndex : 0,
      gradeIndex: gradeIndex >= 0 ? gradeIndex : 2
    });
  },

  onNameInput(e) {
    this.setData({ 'form.name': e.detail.value });
  },

  onClassInput(e) {
    this.setData({ 'form.className': e.detail.value });
  },

  onGenderChange(e) {
    const index = Number(e.detail.value);
    this.setData({
      genderIndex: index,
      'form.gender': this.data.genderOptions[index]
    });
  },

  onGradeChange(e) {
    const index = Number(e.detail.value);
    this.setData({
      gradeIndex: index,
      'form.grade': this.data.gradeOptions[index]
    });
  },

  saveChildInfo() {
    const form = this.data.form;
    if (!form.name.trim()) {
      wx.showToast({ title: '请输入孩子姓名', icon: 'none' });
      return;
    }
    if (!/^\d+$/.test(form.grade)) {
      wx.showToast({ title: '请选择正确年级', icon: 'none' });
      return;
    }

    const payload = {
      name: form.name.trim(),
      gender: form.gender,
      grade: Number(form.grade),
      className: form.className.trim(),
      class: form.className.trim(),
      updateTime: new Date()
    };

    this.setData({ saving: true });
    if (wx.getStorageSync('dataMode') !== 'mock') {
      this.setData({ saving: false });
      wx.showModal({ title: '暂不能修改', content: '后端当前只提供学生创建与查询，尚未提供学生资料更新接口。', showCancel: false });
      return;
    }
    wx.setStorageSync('childInfo', payload);
    this.afterSave();
  },

  afterSave() {
    this.setData({ saving: false });
    wx.showToast({ title: '保存成功', icon: 'success' });
  }
});
