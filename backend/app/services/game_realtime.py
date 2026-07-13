from uuid import uuid4

from sqlalchemy.orm import Session

from .. import state
from .game import china_now, garden_state


def register_game_subscriber(student_id: str, ws) -> None:
    state.game_subscribers[student_id].add(ws)


def unregister_game_subscriber(student_id: str, ws) -> None:
    state.game_subscribers[student_id].discard(ws)


async def broadcast_game_events(student_id: str, events: list[dict], db: Session) -> None:
    if not events or not state.game_subscribers[student_id]:
        return
    payloads = [event_payload(student_id, item["event"], item.get("data", {})) for item in events]
    payloads.append(event_payload(student_id, "garden.updated", garden_state(student_id, db)))
    dead = []
    for ws in state.game_subscribers[student_id]:
        try:
            for payload in payloads:
                await ws.send_json(payload)
        except Exception:
            dead.append(ws)
    for ws in dead:
        unregister_game_subscriber(student_id, ws)


def event_payload(student_id: str, event: str, data: dict) -> dict:
    return {
        "event": event,
        "event_id": f"EVT-{uuid4().hex[:20].upper()}",
        "student_id": student_id,
        "server_time": china_now().isoformat(),
        "data": data,
    }
