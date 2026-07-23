(function exposeSpineGuardApi(global) {
  const search = new URLSearchParams(global.location.search);
  const queryBase = search.get("api");
  const queryMode = search.get("mode");
  if (queryBase) localStorage.setItem("sg.api_base", queryBase);
  localStorage.removeItem("sg.data_mode");
  const config = global.SPINEGUARD_CONFIG || {};
  const configuredBase = global.SPINEGUARD_API_BASE
    || queryBase
    || localStorage.getItem("sg.api_base")
    || config.apiBase
    || "http://127.0.0.1:8000/api/v1";
  const apiBase = configuredBase.replace(/\/$/, "");

  function getToken() {
    return sessionStorage.getItem("sg.access_token") || "";
  }

  function setToken(token) {
    if (token) sessionStorage.setItem("sg.access_token", token);
    else sessionStorage.removeItem("sg.access_token");
  }

  async function request(path, options = {}) {
    const headers = { Accept: "application/json", ...(options.headers || {}) };
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (options.body && !(options.body instanceof FormData)) headers["Content-Type"] = "application/json";

    const response = await fetch(`${apiBase}${path}`, {
      ...options,
      headers,
      body: options.body && !(options.body instanceof FormData) && typeof options.body !== "string"
        ? JSON.stringify(options.body)
        : options.body,
    });

    const contentType = response.headers.get("content-type") || "";
    const payload = contentType.includes("application/json") ? await response.json() : await response.text();
    if (!response.ok) {
      const fallback = {401: "登录状态已失效，请重新登录", 403: "当前账号没有操作权限", 404: "请求的数据暂不存在", 409: "状态已变化，正在重新同步", 422: "请求参数不符合后端要求"}[response.status];
      const detail = payload?.detail;
      const message = payload?.error?.message || (typeof detail === "object" ? detail?.message : detail) || fallback || `请求失败：HTTP ${response.status}`;
      const error = new Error(message);
      error.status = response.status;
      error.code = payload?.error?.code || (typeof detail === "object" ? detail?.code : "") || "";
      error.data = payload?.error?.data || (typeof detail === "object" ? detail?.data || detail : null);
      if (response.status === 401) {
        setToken("");
        global.dispatchEvent(new CustomEvent("spineguard:unauthorized"));
      }
      throw error;
    }
    return payload;
  }

  async function download(path, fallbackFilename) {
    const headers = { Accept: "*/*" };
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(`${apiBase}${path}`, { headers });
    if (!response.ok) {
      const contentType = response.headers.get("content-type") || "";
      const payload = contentType.includes("application/json") ? await response.json() : await response.text();
      throw new Error(payload?.detail || `导出失败：HTTP ${response.status}`);
    }
    const disposition = response.headers.get("content-disposition") || "";
    const filenameMatch = disposition.match(/filename="?([^";]+)"?/i);
    const filename = filenameMatch?.[1] || fallbackFilename;
    const url = URL.createObjectURL(await response.blob());
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  const query = (params) => {
    const values = Object.entries(params || {}).filter(([, value]) => value !== undefined && value !== null && value !== "");
    return values.length ? `?${new URLSearchParams(values).toString()}` : "";
  };

  const realApi = {
    mode: "api",
    apiBase,
    getToken,
    setToken,
    requestRaw: request,
    health: () => fetch(`${apiBase.replace(/\/api\/v1$/, "")}/health`).then((response) => response.json()),
    register: (data) => request("/auth/register", { method: "POST", body: data }),
    login: (username, password) => request("/auth/login", { method: "POST", body: { username, password } }),
    me: () => request("/me"),
    students: () => request("/students"),
    createStudent: (data) => request("/students", { method: "POST", body: data }),
    devices: () => request("/devices"),
    bindDevice: (data) => request("/devices/bind", { method: "POST", body: data }),
    pairDevice: (data) => request("/devices/pair", { method: "POST", body: data }),
    pairingStatus: (pairingId) => request(`/devices/pairings/${encodeURIComponent(pairingId)}`),
    cancelPairing: (pairingId) => request(`/devices/pairings/${encodeURIComponent(pairingId)}`, { method: "DELETE" }),
    deviceStatus: (deviceId) => request("/devices").then((payload) => {
      const device = (payload.items || []).find((item) => item.device_id === deviceId);
      if (!device) {
        const error = new Error(`后端未返回设备 ${deviceId}，请检查账号绑定关系`);
        error.status = 404;
        throw error;
      }
      return {ok: true, data: device};
    }),
    deviceConfig: (deviceId) => request(`/devices/${encodeURIComponent(deviceId)}/config`),
    updateDeviceConfig: (deviceId, data) => request(`/devices/${encodeURIComponent(deviceId)}/config`, { method: "PUT", body: data }),
    deviceLatest: (deviceId) => request(`/devices/${encodeURIComponent(deviceId)}/latest`),
    studentLatest: (studentId) => request(`/students/${encodeURIComponent(studentId)}/latest`),
    studentHistory: (studentId, params = {}) => request(`/students/${encodeURIComponent(studentId)}/history${query(params)}`),
    dailyStats: (studentId, date) => request(`/students/${encodeURIComponent(studentId)}/stats/daily${query({ date })}`),
    weeklyStats: (studentId, week) => request(`/students/${encodeURIComponent(studentId)}/stats/weekly${query({ week })}`),
    risk: (studentId, date) => request(`/students/${encodeURIComponent(studentId)}/risk${query({ date })}`),
    reports: (studentId) => request(`/students/${encodeURIComponent(studentId)}/reports`),
    reportDetail: (studentId, reportId) => request(`/students/${encodeURIComponent(studentId)}/reports/${encodeURIComponent(reportId)}`),
    generateReport: (studentId, data) => request(`/students/${encodeURIComponent(studentId)}/reports/generate`, { method: "POST", body: data }),
    notifications: (unreadOnly = false) => request(`/notifications${query({ unread_only: unreadOnly })}`),
    readNotification: (id) => request(`/notifications/${encodeURIComponent(id)}/read`, { method: "POST" }),
    adminOverview: () => request("/admin/overview"),
    adminClasses: () => request("/admin/classes"),
    adminClassStudents: (classId) => request(`/admin/classes/${encodeURIComponent(classId)}/students`),
    adminRiskStudents: (riskLevel = "all") => request(`/admin/risk-students${query({ risk_level: riskLevel })}`),
    studentGarden: (studentId) => request(`/students/${encodeURIComponent(studentId)}/garden`),
    downloadAdminRiskExport: (params = {}) => download(
      `/admin/risk-students/export${query(params)}`,
      "spineguard-risk-students.zip",
    ),
  };
  const configuredMode = queryMode === "mock" || queryMode === "api"
    ? queryMode
    : (config.mode || (config.useMock === false ? "api" : "mock"));
  const useMock = configuredMode === "mock";
  global.SpineGuardRealApi = realApi;
  global.SpineGuardApi = useMock && global.SpineGuardMockApi ? global.SpineGuardMockApi : realApi;
})(window);
