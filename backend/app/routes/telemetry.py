from fastapi import APIRouter, Depends, Header, HTTPException, Query, WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session

from ..config import API_PREFIX, DEVICE_TOKEN
from ..db import SessionLocal, get_db
from ..schemas import Telemetry
from ..services.telemetry import (
    get_device_history,
    get_device_latest,
    register_subscriber,
    save_telemetry,
    unregister_subscriber,
)

router = APIRouter(prefix=API_PREFIX)


@router.post("/device/telemetry")
async def receive(
    data: Telemetry,
    x_device_token: str = Header(default=""),
    db: Session = Depends(get_db),
):
    if x_device_token != DEVICE_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid device token")

    await save_telemetry(data, db)
    return {"ok": True, "received_seq": data.seq}


@router.get("/devices/{device_id}/latest")
def latest(device_id: str, db: Session = Depends(get_db)):
    return {"ok": True, "data": get_device_latest(device_id, db)}


@router.get("/devices/{device_id}/history")
def history(
    device_id: str,
    limit: int = Query(100, ge=1, le=2000),
    db: Session = Depends(get_db),
):
    return {"ok": True, "items": get_device_history(device_id, limit, db)}


@router.websocket("/ws/devices/{device_id}")
async def ws_device(ws: WebSocket, device_id: str):
    await ws.accept()
    register_subscriber(device_id, ws)

    db = SessionLocal()
    current = get_device_latest(device_id, db)
    db.close()
    if current is not None:
        payload = current.model_dump() if hasattr(current, "model_dump") else current
        await ws.send_json(payload)

    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        unregister_subscriber(device_id, ws)
