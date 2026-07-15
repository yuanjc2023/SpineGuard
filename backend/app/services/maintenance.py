import asyncio
from contextlib import suppress

from ..db import SessionLocal
from ..config import AUTO_REPORT_CATCH_UP_DAYS, AUTO_REPORT_ENABLED, AUTO_REPORT_USE_LLM
from .game import expire_offline_sessions, settle_due_growth, settle_previous_daily_tasks
from .game_realtime import broadcast_game_events
from .scheduled_reports import run_due_reports

MAINTENANCE_INTERVAL_S = 5


async def maintenance_loop() -> None:
    catch_up = True
    while True:
        events = await asyncio.to_thread(run_maintenance_once, catch_up)
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

    if AUTO_REPORT_ENABLED:
        report_db = SessionLocal()
        try:
            report_results = run_due_reports(
                report_db,
                use_llm=AUTO_REPORT_USE_LLM,
                catch_up_days=AUTO_REPORT_CATCH_UP_DAYS if catch_up else 1,
            )
            report_db.commit()
            events.extend(
                {
                    "student_id": item["student_id"],
                    "event": "report.generated",
                    "data": item,
                }
                for item in report_results
                if item["status"] == "completed"
            )
        except Exception:
            report_db.rollback()
        finally:
            report_db.close()
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
