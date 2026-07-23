const config = require('../config/env');

function apiBase() {
  const runtimeBase = wx.getStorageSync('apiBase');
  let configuredBase = config.apiBase;
  if (!runtimeBase && typeof wx.getDeviceInfo === 'function') {
    const deviceInfo = wx.getDeviceInfo();
    if (deviceInfo && deviceInfo.platform !== 'devtools' && config.deviceApiBase) configuredBase = config.deviceApiBase;
  }
  return String(runtimeBase || configuredBase).replace(/\/$/, '');
}

function request(options) {
  const token = wx.getStorageSync('accessToken');
  const headers = Object.assign({ 'Content-Type': 'application/json' }, options.header || {});
  if (options.auth !== false && token) headers.Authorization = `Bearer ${token}`;

  return new Promise((resolve, reject) => {
    wx.request({
      url: `${apiBase()}${options.path}`,
      method: options.method || 'GET',
      data: options.data,
      header: headers,
      timeout: options.timeout || config.requestTimeoutMs,
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data);
          return;
        }
        const payload = res.data || {};
        const detail = payload.detail !== undefined ? payload.detail : payload.error;
        const fallback = {
          401: '登录状态已失效，请重新登录', 403: '当前账号没有操作权限',
          404: '请求的数据暂不存在', 409: '状态已变化，正在重新同步', 422: '请求参数不符合后端要求'
        }[res.statusCode];
        const validationMessage = Array.isArray(detail) && detail[0] ? detail[0].msg : '';
        const detailMessage = detail && typeof detail === 'object' && !Array.isArray(detail)
          ? (detail.message || detail.msg || '')
          : (typeof detail === 'string' ? detail : validationMessage);
        const error = new Error(detailMessage || fallback || `后端请求失败（HTTP ${res.statusCode}）`);
        error.statusCode = res.statusCode;
        error.code = (payload.error && payload.error.code)
          || (detail && typeof detail === 'object' && !Array.isArray(detail) ? detail.code : '')
          || '';
        error.data = (payload.error && payload.error.data)
          || (detail && typeof detail === 'object' && !Array.isArray(detail) ? (detail.data || detail) : null);
        if (res.statusCode === 401 && options.auth !== false) {
          ['accessToken', 'currentUser', 'currentStudent', 'boundDevice', 'deviceState'].forEach((key) => wx.removeStorageSync(key));
          setTimeout(() => wx.reLaunch({ url: '/pages/login/login' }), 0);
        }
        reject(error);
      },
      fail(error) {
        const message = error && error.errMsg ? error.errMsg : '无法连接后端';
        reject(new Error(`${message}；请确认后端地址 ${apiBase()}`));
      }
    });
  });
}

module.exports = { request, apiBase };
