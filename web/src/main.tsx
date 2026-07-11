import {useEffect, useState} from "react";
import {createRoot} from "react-dom/client";
import "./style.css";

type Frame = {
  posture:string; confidence:number; pressure:Record<string,number>;
  pressure_features:{
    total_pressure:number; left_right_diff:number; front_back_diff:number;
    center_x:number; center_y:number; asymmetry_index:number;
  };
  imu:{tilt_x:number; tilt_y:number; shake_level:number};
  sitting_duration_s:number; recognition_source:string; warning_active:boolean;
  reminder_count:number; battery_level:number;
};

const API = "http://127.0.0.1:8000/api/v1";
const names:Record<string,string> = {
  empty:"无人",normal:"正常坐姿",left_lean:"左倾",right_lean:"右倾",
  front_lean:"前倾",back_lean:"后倾",unknown:"未知"
};

function App(){
  const [frame,setFrame]=useState<Frame|null>(null);
  const [error,setError]=useState("");
  useEffect(()=>{
    const load=()=>fetch(`${API}/devices/SG-0001/latest`)
      .then(r=>r.json()).then(v=>{setFrame(v.data);setError("")})
      .catch(e=>setError(String(e)));
    load(); const id=setInterval(load,1000); return()=>clearInterval(id);
  },[]);
  return <main>
    <h1>SpineGuard管理端</h1>
    <p className="sub">设备遥测联调面板</p>
    {error&&<div className="error">{error}</div>}
    <section className="hero">
      <div><span>当前坐姿</span><strong>{frame?names[frame.posture]:"等待数据"}</strong></div>
      <div><span>置信度</span><b>{frame?Math.round(frame.confidence*100)+"%":"--"}</b></div>
      <div><span>连续就坐</span><b>{frame?frame.sitting_duration_s+"s":"--"}</b></div>
      <div><span>来源</span><b>{frame?.recognition_source??"--"}</b></div>
    </section>
    <section>
      <h2>5点压力</h2>
      <div className="grid">
        {["left","right","front","back","center"].map(k=>
          <div className="card" key={k}><span>{k}</span><strong>{frame?.pressure[k]??0}</strong></div>
        )}
      </div>
    </section>
  </main>
}
createRoot(document.getElementById("root")!).render(<App/>);
