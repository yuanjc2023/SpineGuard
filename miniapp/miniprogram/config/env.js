module.exports = {
  // 开发者工具连接本机 FastAPI。
  mode: 'api',
  // 只在 mock 模式生效，也可在 Storage 中设置 quickTest=true。
  quickTest:true,
  apiBase:'http://10.12.173.179:8000/api/v1',
  // 真机无法访问 127.0.0.1；网络变化后只需更新此处，或在 Storage 中设置 apiBase 临时覆盖。
  deviceApiBase:'http://10.12.173.179:8000/api/v1',
  defaultDeviceId: 'SG-0001',
  refreshIntervalMs: 2000,
  requestTimeoutMs: 6000
};
