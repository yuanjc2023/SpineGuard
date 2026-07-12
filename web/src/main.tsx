import {useEffect, useMemo, useRef, useState} from "react";
import {createRoot} from "react-dom/client";
import "./style.css";

type User = {user_id:string; username:string; role:string};
type Student = {student_id:string; display_code:string; school_id:string|null; class_id:string|null};
type Device = {device_id:string; online_status:string; battery_level:number|null; firmware_version:string; model_version:string};

const API = import.meta.env.VITE_API_BASE || "http://127.0.0.1:8000/api/v1";
const postureNames:Record<string,string> = {
  empty:"无人", normal:"正常", left_lean:"左倾", right_lean:"右倾", front_lean:"前倾", back_lean:"后倾", unknown:"未知"
};
const postures = Object.keys(postureNames);

function App(){
  const [token,setToken] = useState(localStorage.getItem("sg_token") || "");
  const [user,setUser] = useState<User|null>(null);
  const [username,setUsername] = useState("parent_demo");
  const [password,setPassword] = useState("parent123");
  const [role,setRole] = useState("parent");
  const [studentId,setStudentId] = useState("");
  const [studentCode,setStudentCode] = useState("STU-DEMO-LOCAL");
  const [deviceId,setDeviceId] = useState("SG-TEST-001");
  const [deviceToken,setDeviceToken] = useState("device-secret");
  const [uploadToken,setUploadToken] = useState("dev-token");
  const [posture,setPosture] = useState("normal");
  const [seq,setSeq] = useState(1);
  const [students,setStudents] = useState<Student[]>([]);
  const [devices,setDevices] = useState<Device[]>([]);
  const [latest,setLatest] = useState<any>(null);
  const [history,setHistory] = useState<any[]>([]);
  const [daily,setDaily] = useState<any>(null);
  const [weekly,setWeekly] = useState<any>(null);
  const [risk,setRisk] = useState<any>(null);
  const [reports,setReports] = useState<any[]>([]);
  const [overview,setOverview] = useState<any>(null);
  const [classes,setClasses] = useState<any[]>([]);
  const [riskStudents,setRiskStudents] = useState<any[]>([]);
  const [notifications,setNotifications] = useState<any[]>([]);
  const [wsStatus,setWsStatus] = useState("未连接");
  const [wsMessages,setWsMessages] = useState<any[]>([]);
  const [log,setLog] = useState("等待操作");
  const wsRef = useRef<WebSocket|null>(null);

  const authHeaders = useMemo(
    (): Record<string,string> => token ? {Authorization:`Bearer ${token}`} : {},
    [token]
  );
  const today = "2026-07-11";
  const week = "2026-W28";

  async function api(path:string, options:RequestInit={}){
    const headers:Record<string,string> = {
      "Content-Type":"application/json",
      ...(options.headers as Record<string,string> || {})
    };
    const res = await fetch(`${API}${path}`, {...options, headers});
    const text = await res.text();
    const data = text ? safeJson(text) : null;
    if(!res.ok) throw new Error(data?.detail || data?.error?.message || `HTTP ${res.status}`);
    setLog(JSON.stringify(data, null, 2));
    return data;
  }

  async function download(path:string, filename:string){
    const res = await fetch(`${API}${path}`, {headers:authHeaders});
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    setLog(`已下载 ${filename}`);
  }

  function safeJson(text:string){
    try{return JSON.parse(text)}catch{return text}
  }

  async function login(){
    const data = await api("/auth/login", {method:"POST", body:JSON.stringify({username,password})});
    setToken(data.access_token);
    setUser(data.user);
    localStorage.setItem("sg_token", data.access_token);
  }

  async function register(){
    await api("/auth/register", {method:"POST", body:JSON.stringify({username,password,role})});
  }

  async function loadMe(){
    const data = await api("/me", {headers:authHeaders});
    setUser(data.data);
  }

  function logout(){
    setToken("");
    setUser(null);
    localStorage.removeItem("sg_token");
    closeWs();
  }

  async function createStudent(){
    const data = await api("/students", {
      method:"POST",
      headers:authHeaders,
      body:JSON.stringify({display_code:studentCode, school_id:"SCH-DEMO", class_id:"CLASS-DEMO"})
    });
    setStudentId(data.data.student_id);
    await listStudents();
  }

  async function listStudents(){
    const data = await api("/students", {headers:authHeaders});
    setStudents(data.items || []);
    if(!studentId && data.items?.[0]) setStudentId(data.items[0].student_id);
  }

  async function createDevice(){
    await api("/devices", {
      method:"POST",
      headers:authHeaders,
      body:JSON.stringify({device_id:deviceId, device_token:deviceToken, firmware_version:"0.1.0", model_version:"rule-v0.1"})
    });
    await listDevices();
  }

  async function listDevices(){
    const data = await api("/devices", {headers:authHeaders});
    setDevices(data.items || []);
    if(data.items?.[0]) setDeviceId(data.items[0].device_id);
  }

  async function bindDevice(){
    await api("/devices/bind", {
      method:"POST",
      headers:authHeaders,
      body:JSON.stringify({device_id:deviceId, student_id:studentId, bind_code:"123456"})
    });
  }

  async function uploadMockTelemetry(){
    const payload = buildTelemetry();
    await api("/device/telemetry", {
      method:"POST",
      headers:{"X-Device-Token":uploadToken},
      body:JSON.stringify(payload)
    });
    setSeq(seq + 1);
  }

  function buildTelemetry(){
    const left = randomInt(360, 760);
    const right = randomInt(360, 760);
    const front = randomInt(300, 680);
    const back = randomInt(300, 680);
    const center = randomInt(420, 820);
    const total = left + right + front + back + center;
    return {
      protocol_version:1,
      device_id:deviceId,
      session_id:"WEB-DEMO",
      seq,
      timestamp_ms:Date.now(),
      posture,
      confidence:0.92,
      pressure:{left,right,front,back,center},
      pressure_features:{
        total_pressure:total,
        left_right_diff:left-right,
        front_back_diff:front-back,
        center_x:round((left-right)/1000),
        center_y:round((front-back)/1000),
        asymmetry_index:round(Math.min(Math.abs(left-right)/Math.max(left+right,1), 1))
      },
      imu:{tilt_x:posture==="front_lean"?12:0, tilt_y:posture==="left_lean"?10:0, shake_level:0.05},
      posture_duration_s:posture==="normal"?30:45,
      sitting_duration_s:seq*30,
      vibration_enabled:true,
      warning_active:posture!=="normal",
      reminder_count:posture==="normal"?0:seq,
      battery_level:88,
      recognition_source:"mock",
      model_version:"mock-web-v0.1",
      firmware_version:"0.1.0"
    };
  }

  async function loadRealtime(){
    const latestData = await api(`/students/${studentId}/latest`, {headers:authHeaders});
    setLatest(latestData.data);
    const historyData = await api(`/students/${studentId}/history?limit=20`, {headers:authHeaders});
    setHistory(historyData.items || []);
  }

  async function loadStats(){
    const d = await api(`/students/${studentId}/stats/daily?date=${today}`, {headers:authHeaders});
    setDaily(d.data);
    const w = await api(`/students/${studentId}/stats/weekly?week=${week}`, {headers:authHeaders});
    setWeekly(w.data);
  }

  async function loadRisk(){
    const data = await api(`/students/${studentId}/risk?date=${today}`, {headers:authHeaders});
    setRisk(data.data);
  }

  async function generateReport(useLlm:boolean){
    const data = await api(`/students/${studentId}/reports/generate`, {
      method:"POST",
      headers:authHeaders,
      body:JSON.stringify({report_type:"weekly", use_llm:useLlm, date:today})
    });
    setReports([data.data, ...reports]);
  }

  async function listReports(){
    const data = await api(`/students/${studentId}/reports`, {headers:authHeaders});
    setReports(data.items || []);
  }

  async function loadAdmin(){
    const o = await api("/admin/overview", {headers:authHeaders});
    setOverview(o.data);
    const c = await api("/admin/classes", {headers:authHeaders});
    setClasses(c.items || []);
    const r = await api("/admin/risk-students?risk_level=all", {headers:authHeaders});
    setRiskStudents(r.items || []);
  }

  async function createNotification(){
    await api("/notifications", {
      method:"POST",
      headers:authHeaders,
      body:JSON.stringify({
        student_id:studentId || null,
        notification_type:"risk",
        title:"坐姿风险提示",
        content:"请关注近期坐姿行为风险提示。"
      })
    });
    await listNotifications();
  }

  async function listNotifications(){
    const data = await api("/notifications", {headers:authHeaders});
    setNotifications(data.items || []);
  }

  async function markRead(id:string){
    await api(`/notifications/${id}/read`, {method:"POST", headers:authHeaders});
    await listNotifications();
  }

  function connectWs(){
    if(!token || !studentId) return setLog("请先登录并填写 student_id");
    closeWs();
    const wsBase = API.replace(/^http/, "ws");
    const ws = new WebSocket(`${wsBase}/ws/students/${studentId}?token=${encodeURIComponent(token)}`);
    wsRef.current = ws;
    ws.onopen = () => setWsStatus("已连接");
    ws.onclose = () => setWsStatus("已断开");
    ws.onerror = () => setWsStatus("连接错误");
    ws.onmessage = event => {
      const data = safeJson(event.data);
      setWsMessages(items => [data, ...items].slice(0, 5));
    };
  }

  function closeWs(){
    wsRef.current?.close();
    wsRef.current = null;
    setWsStatus("未连接");
  }

  function quick(roleName:"parent"|"school_admin"){
    if(roleName === "parent"){
      setUsername("parent_demo"); setPassword("parent123");
    }else{
      setUsername("school_admin_demo"); setPassword("admin123");
    }
  }

  useEffect(()=>{ if(token && !user) loadMe().catch(e=>setLog(String(e))); }, [token]);

  return <main>
    <header className="topbar">
      <div>
        <h1>SpineGuard 后端联调面板</h1>
        <p>API: {API}</p>
      </div>
      <div className="badge">{user ? `${user.username} / ${user.role}` : "未登录"}</div>
    </header>

    <section className="grid2">
      <Panel title="1. 登录">
        <div className="inline">
          <button className="soft" onClick={()=>quick("parent")}>家长测试号</button>
          <button className="soft" onClick={()=>quick("school_admin")}>管理员测试号</button>
        </div>
        <Field label="用户名" value={username} onChange={setUsername}/>
        <Field label="密码" value={password} onChange={setPassword} type="password"/>
        <label>角色
          <select value={role} onChange={e=>setRole(e.target.value)}>
            <option value="parent">parent</option>
            <option value="school_admin">school_admin</option>
            <option value="doctor">doctor</option>
            <option value="admin">admin</option>
          </select>
        </label>
        <Actions>
          <button onClick={()=>login().catch(err)} >登录</button>
          <button onClick={()=>register().catch(err)}>注册</button>
          <button onClick={()=>loadMe().catch(err)}>查 /me</button>
          <button className="ghost" onClick={logout}>退出</button>
        </Actions>
      </Panel>

      <Panel title="2. 学生 / 设备 / 绑定">
        <Field label="学生显示编号" value={studentCode} onChange={setStudentCode}/>
        <Field label="学生 ID" value={studentId} onChange={setStudentId}/>
        <Field label="设备 ID" value={deviceId} onChange={setDeviceId}/>
        <Field label="设备密钥" value={deviceToken} onChange={setDeviceToken}/>
        <Actions>
          <button onClick={()=>createStudent().catch(err)}>创建学生</button>
          <button onClick={()=>listStudents().catch(err)}>学生列表</button>
          <button onClick={()=>createDevice().catch(err)}>创建设备</button>
          <button onClick={()=>listDevices().catch(err)}>设备列表</button>
          <button onClick={()=>bindDevice().catch(err)}>绑定设备</button>
        </Actions>
      </Panel>
    </section>

    <section className="grid2">
      <Panel title="3. 模拟设备上传">
        <Field label="上传接口 Token" value={uploadToken} onChange={setUploadToken}/>
        <label>模拟坐姿
          <select value={posture} onChange={e=>setPosture(e.target.value)}>
            {postures.map(item => <option key={item} value={item}>{postureNames[item]}</option>)}
          </select>
        </label>
        <Actions>
          <button onClick={()=>uploadMockTelemetry().catch(err)}>上传 1 条 mock 遥测</button>
          <button onClick={()=>loadRealtime().catch(err)}>刷新实时/历史</button>
          <button onClick={connectWs}>连接学生 WebSocket</button>
          <button className="ghost" onClick={closeWs}>断开</button>
        </Actions>
        <p className="hint">WebSocket: {wsStatus}</p>
      </Panel>

      <Panel title="4. 统计 / 风险 / 报告">
        <Actions>
          <button onClick={()=>loadStats().catch(err)}>日报 + 周报</button>
          <button onClick={()=>loadRisk().catch(err)}>风险提示</button>
          <button onClick={()=>generateReport(false).catch(err)}>规则报告</button>
          <button onClick={()=>generateReport(true).catch(err)}>LLM 报告</button>
          <button onClick={()=>listReports().catch(err)}>报告列表</button>
        </Actions>
        <div className="summary">
          <Metric label="今日标准率" value={daily ? `${Math.round(daily.normal_ratio*100)}%` : "--"}/>
          <Metric label="周标准率" value={weekly ? `${Math.round(weekly.normal_ratio*100)}%` : "--"}/>
          <Metric label="风险等级" value={risk?.risk_level || "--"}/>
        </div>
      </Panel>
    </section>

    <section className="grid2">
      <Panel title="5. 管理员接口">
        <Actions>
          <button onClick={()=>loadAdmin().catch(err)}>总览/班级/风险学生</button>
          <button onClick={()=>download(`/admin/export?from=${today}&to=${today}&format=csv`, "spineguard.csv").catch(err)}>导出 CSV</button>
          <button onClick={()=>download(`/admin/export?from=${today}&to=${today}&format=xlsx`, "spineguard.xlsx").catch(err)}>导出 Excel</button>
          <button onClick={()=>download(`/admin/risk-students/export?risk_level=red&from=${today}&to=${today}`, "risk-students.zip").catch(err)}>风险学生 ZIP</button>
        </Actions>
        <div className="summary">
          <Metric label="学生数" value={overview?.student_count ?? "--"}/>
          <Metric label="设备数" value={overview?.device_count ?? "--"}/>
          <Metric label="高风险" value={overview?.high_risk_student_count ?? "--"}/>
        </div>
      </Panel>

      <Panel title="6. 小程序通知">
        <Actions>
          <button onClick={()=>createNotification().catch(err)}>创建风险通知</button>
          <button onClick={()=>listNotifications().catch(err)}>通知列表</button>
        </Actions>
        <div className="list">
          {notifications.map(item => <button className="row" key={item.notification_id} onClick={()=>markRead(item.notification_id).catch(err)}>
            <span>{item.title}</span><b>{item.is_read ? "已读" : "未读"}</b>
          </button>)}
        </div>
      </Panel>
    </section>

    <section className="realtime">
      <Metric label="当前坐姿" value={latest ? postureNames[latest.posture] : "--"}/>
      <Metric label="置信度" value={latest ? `${Math.round(latest.confidence*100)}%` : "--"}/>
      <Metric label="压力不对称" value={latest?.pressure_features?.asymmetry_index ?? "--"}/>
      <Metric label="提醒次数" value={latest?.reminder_count ?? "--"}/>
      <Metric label="电量" value={latest ? `${latest.battery_level}%` : "--"}/>
    </section>

    <section className="grid3">
      <Data title="学生" data={students}/>
      <Data title="设备" data={devices}/>
      <Data title="历史" data={history.slice(-5)}/>
      <Data title="日报" data={daily}/>
      <Data title="周报" data={weekly}/>
      <Data title="风险" data={risk}/>
      <Data title="报告" data={reports.slice(0,2)}/>
      <Data title="班级" data={classes}/>
      <Data title="高风险学生" data={riskStudents}/>
      <Data title="WebSocket" data={wsMessages}/>
      <Data title="接口返回" data={log}/>
    </section>
  </main>;

  function err(error:any){ setLog(String(error)); }
}

function Field(props:{label:string; value:string; onChange:(value:string)=>void; type?:string}){
  return <label>{props.label}<input type={props.type || "text"} value={props.value} onChange={e=>props.onChange(e.target.value)}/></label>;
}

function Panel(props:{title:string; children:any}){
  return <section className="panel"><h2>{props.title}</h2>{props.children}</section>;
}

function Actions(props:{children:any}){
  return <div className="actions">{props.children}</div>;
}

function Metric(props:{label:string; value:any}){
  return <div className="metric"><span>{props.label}</span><strong>{String(props.value)}</strong></div>;
}

function Data(props:{title:string; data:any}){
  return <section className="panel data"><h2>{props.title}</h2><pre>{typeof props.data === "string" ? props.data : JSON.stringify(props.data, null, 2)}</pre></section>;
}

function randomInt(min:number, max:number){ return Math.floor(Math.random()*(max-min+1))+min; }
function round(value:number){ return Math.round(value*1000)/1000; }

createRoot(document.getElementById("root")!).render(<App/>);
