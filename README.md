# SpineGuard

基于ESP32-S3、多点FSR压力感知、边缘坐姿识别和云端分析的智能坐姿健康管理原型。

当前骨架先打通：

```text
ESP32-S3/模拟设备
→HTTP上传
→FastAPI后端
→Web 管理端
→微信小程序客户端
```

当前允许使用模拟数据。后续5个FSR和模型完成后，只替换设备端的数据来源与识别模块，协议保持不变。

## 目录

```text
firmware/   ESP-IDF固件
backend/    FastAPI后端
web/        Web 管理端（支持 Mock/真实 API 双模式）
miniapp/    微信小程序完整工程
shared/     公共协议
scripts/    模拟设备
docs/       架构与开发说明
```

## 模拟联调

### 后端

```powershell
cd backend
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

### Web

```powershell
cd web
npm install
npm run dev
```

### 模拟设备

```powershell
pip install httpx
python scripts/send_mock_telemetry.py
```

Web地址：`http://127.0.0.1:5500`

API文档：`http://127.0.0.1:8000/docs`
