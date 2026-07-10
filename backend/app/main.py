import os
from collections import defaultdict, deque
from typing import Literal

from fastapi import FastAPI, Header, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

Posture = Literal["empty","normal","left_lean","right_lean","front_lean","back_lean","unknown"]

class Pressure(BaseModel):
    left: int = Field(ge=0, le=1000)
    right: int = Field(ge=0, le=1000)
    front: int = Field(ge=0, le=1000)
    back: int = Field(ge=0, le=1000)
    center: int = Field(ge=0, le=1000)

class Telemetry(BaseModel):
    protocol_version: Literal[1] = 1
    device_id: str
    session_id: str
    seq: int = Field(ge=0)
    timestamp_ms: int = Field(ge=0)
    posture: Posture
    confidence: float = Field(ge=0, le=1)
    pressure: Pressure
    posture_duration_s: int = Field(ge=0)
    sitting_duration_s: int = Field(ge=0)
    vibration_enabled: bool
    warning_active: bool
    recognition_source: Literal["rule","neural_network","mock"]
    model_version: str
    firmware_version: str

app = FastAPI(title="SpineGuard API", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

TOKEN = os.getenv("SPINEGUARD_DEVICE_TOKEN", "dev-token")
latest: dict[str, Telemetry] = {}
history: dict[str, deque[Telemetry]] = defaultdict(lambda: deque(maxlen=5000))
subscribers: dict[str, set[WebSocket]] = defaultdict(set)

@app.get("/health")
def health():
    return {"status":"ok","version":"0.1.0"}

@app.post("/api/v1/device/telemetry")
async def receive(data: Telemetry, x_device_token: str = Header(default="")):
    if x_device_token != TOKEN:
        raise HTTPException(status_code=401, detail="Invalid device token")
    latest[data.device_id] = data
    history[data.device_id].append(data)
    dead = []
    for ws in subscribers[data.device_id]:
        try:
            await ws.send_json(data.model_dump())
        except Exception:
            dead.append(ws)
    for ws in dead:
        subscribers[data.device_id].discard(ws)
    return {"ok":True,"received_seq":data.seq}

@app.get("/api/v1/devices/{device_id}/latest")
def get_latest(device_id: str):
    return {"ok":True,"data":latest.get(device_id)}

@app.get("/api/v1/devices/{device_id}/history")
def get_history(device_id: str, limit: int = Query(100, ge=1, le=2000)):
    return {"ok":True,"items":list(history[device_id])[-limit:]}

@app.websocket("/api/v1/ws/devices/{device_id}")
async def ws_device(ws: WebSocket, device_id: str):
    await ws.accept()
    subscribers[device_id].add(ws)
    if device_id in latest:
        await ws.send_json(latest[device_id].model_dump())
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        subscribers[device_id].discard(ws)
