from fastapi import APIRouter, Depends, Header, HTTPException, Query, WebSocket, WebSocketDisconnect, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import API_PREFIX
from ..db import SessionLocal, get_db
from ..models import User, UserStudentLink
from ..schemas import Telemetry
from ..services.auth import decode_access_token
from ..services.device_management import authenticate_device
from ..services.game_realtime import broadcast_game_events
from ..services.telemetry import (
    get_device_history,
    get_device_latest,
    get_student_latest,
    register_subscriber,
    register_student_subscriber,
    save_telemetry,
    unregister_subscriber,
    unregister_student_subscriber,
)

router = APIRouter(prefix=API_PREFIX)


@router.post("/device/telemetry")
async def receive(
    data: Telemetry,
    x_device_id: str = Header(default=""),
    x_device_token: str = Header(default=""),
    db: Session = Depends(get_db),
):
    if x_device_id and x_device_id != data.device_id:
        raise HTTPException(status_code=401, detail="Device ID mismatch")
    authenticate_device(data.device_id, x_device_token, db)

    result = await save_telemetry(data, db)
    if result["student_id"]:
        await broadcast_game_events(result["student_id"], result["game_events"], db)
    return {"ok": True, "received_seq": data.seq, "duplicate": result["duplicate"]}


@router.get("/devices/{device_id}/latest")
def latest(device_id: str, db: Session = Depends(get_db)):
    return {"ok": True, "data": get_device_latest(device_id, db)}


@router.get("/devices/{device_id}/history")
def history(
    device_id: str,
    limit: int = Query(100, ge=1, le=2000),
    from_value: str | None = Query(default=None, alias="from"),
    to_value: str | None = Query(default=None, alias="to"),
    db: Session = Depends(get_db),
):
    try:
        items = get_device_history(device_id, limit, db, from_value, to_value)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, "items": items}


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


@router.websocket("/ws/students/{student_id}")
async def ws_student(ws: WebSocket, student_id: str):
    token = ws.query_params.get("token")
    db = SessionLocal()
    try:
        current_user = websocket_current_user(token, db)
        ensure_websocket_student_access(student_id, current_user, db)
    except HTTPException as exc:
        db.close()
        await ws.close(code=1008, reason=str(exc.detail))
        return

    await ws.accept()
    register_student_subscriber(student_id, ws)
    current = get_student_latest(student_id, db)
    db.close()
    if current is not None:
        await ws.send_json(current)

    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        unregister_student_subscriber(student_id, ws)


def websocket_current_user(token: str | None, db: Session) -> User:
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing token")
    payload = decode_access_token(token)
    user = db.scalar(select(User).where(User.user_id == payload.get("sub")))
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    return user


def ensure_websocket_student_access(student_id: str, current_user: User, db: Session) -> None:
    if current_user.role in ("school_admin", "doctor", "admin"):
        return
    link = db.scalar(
        select(UserStudentLink).where(
            UserStudentLink.user_id == current_user.user_id,
            UserStudentLink.student_id == student_id,
        )
    )
    if link is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")
