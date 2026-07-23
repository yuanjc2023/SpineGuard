window.SPINEGUARD_CONFIG = {
  // 唯一数据模式：mock 完整演示；api 连接 FastAPI。
  mode: "api",
  // 仅 mock 生效；也可用 ?mode=mock&quick=1 临时开启。
  quickTest: false,
  apiBase: "http://127.0.0.1:8000/api/v1",
  mockTelemetryIntervalMs: 2200,
};
