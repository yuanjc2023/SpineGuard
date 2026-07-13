import asyncio
from contextlib import suppress

from ..db import SessionLocal
from .game import expire_offline_sessions, settle_due_growth, settle_previous_daily_tasks
from .game_realtime import broadcast_game_events

MAINTENANCE_INTERVAL_S = 5


async def maintenance_loop() -> None:
    catch_up = True
    while True:
        events = run_maintenance_once(catch_up=catch_up)
        await broadcast_maintenance_events(events)
        catch_up = False
        await asyncio.sleep(MAINTENANCE_INTERVAL_S)


def run_maintenance_once(catch_up: bool = False) -> list[dict]:
    db = SessionLocal()
    events: list[dict] = []
    try:
        events.extend(expire_offline_sessions(db))
        settlements = settle_due_growth(db, catch_up=catch_up)
        events.extend(
            {
                "student_id": item["student_id"],
                "event": "garden.updated",
                "data": {"settlement": item},
            }
            for item in settlements
        )
        settle_previous_daily_tasks(db)
        db.commit()
    except Exception:
        db.rollback()
        events = []
    finally:
        db.close()
    return events


async def broadcast_maintenance_events(events: list[dict]) -> None:
    for item in events:
        db = SessionLocal()
        try:
            await broadcast_game_events(item["student_id"], [item], db)
            db.commit()
        finally:
            db.close()


async def stop_maintenance(task: asyncio.Task | None) -> None:
    if task is None:
        return
    task.cancel()
    with suppress(asyncio.CancelledError):
        await task
