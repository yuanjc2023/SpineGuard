from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect, status
from sqlalchemy.orm import Session

from ..config import API_PREFIX
from ..db import SessionLocal, get_db
from ..models import User
from ..schemas import GardenActionRequest, IdempotentRequest
from ..services.auth import get_current_user
from ..services.game import (
    GameConflict,
    claim_task,
    game_rules,
    garden_state,
    ledger_items,
    perform_action,
)
from ..services.game_realtime import register_game_subscriber, unregister_game_subscriber
from .students import ensure_student_access
from .telemetry import ensure_websocket_student_access, websocket_current_user

router = APIRouter(prefix=API_PREFIX, tags=["game"])


@router.get("/game/rules")
def get_game_rules(_: User = Depends(get_current_user)):
    return {"ok": True, "data": game_rules()}


@router.get("/students/{student_id}/garden")
def get_garden(
    student_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ensure_student_access(student_id, current_user, db)
    result = garden_state(student_id, db)
    db.commit()
    return {"ok": True, "data": result}


@router.post("/students/{student_id}/daily-tasks/{task_id}/claim")
def post_task_claim(
    student_id: str,
    task_id: str,
    data: IdempotentRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ensure_student_access(student_id, current_user, db)
    try:
        result = claim_task(student_id, task_id, data.idempotency_key, current_user.user_id, db)
        db.commit()
    except GameConflict as exc:
        db.rollback()
        raise game_http_error(exc) from exc
    return {"ok": True, "data": result}


@router.post("/students/{student_id}/garden/actions")
def post_garden_action(
    student_id: str,
    data: GardenActionRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ensure_student_access(student_id, current_user, db)
    try:
        result = perform_action(
            student_id,
            data.action,
            data.quantity,
            data.idempotency_key,
            current_user.user_id,
            db,
        )
        db.commit()
    except GameConflict as exc:
        db.rollback()
        raise game_http_error(exc) from exc
    return {"ok": True, "data": result}


@router.get("/students/{student_id}/reward-ledger")
def get_reward_ledger(
    student_id: str,
    cursor: int | None = Query(default=None, ge=1),
    limit: int = Query(default=50, ge=1, le=100),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ensure_student_access(student_id, current_user, db)
    items = ledger_items(student_id, db, cursor, limit)
    return {
        "ok": True,
        "items": items,
        "next_cursor": items[-1]["cursor"] if len(items) == limit else None,
    }


@router.websocket("/ws/students/{student_id}/game")
async def ws_game(ws: WebSocket, student_id: str):
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
    register_game_subscriber(student_id, ws)
    await ws.send_json(
        {
            "event": "garden.updated",
            "event_id": "initial",
            "student_id": student_id,
            "server_time": garden_state(student_id, db)["server_time"],
            "data": garden_state(student_id, db),
        }
    )
    db.commit()
    db.close()
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        unregister_game_subscriber(student_id, ws)


def game_http_error(exc: GameConflict) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={"code": exc.code, "message": exc.message},
    )
