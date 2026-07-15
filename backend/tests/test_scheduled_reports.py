import os
from datetime import datetime, timezone
from pathlib import Path

TEST_DB_PATH = Path(
    os.getenv(
        "SPINEGUARD_TEST_DB_PATH",
        str(Path(__file__).resolve().parents[1] / "test_spineguard.db"),
    )
)
os.environ["DATABASE_URL"] = f"sqlite:///{TEST_DB_PATH.as_posix()}"
os.environ["AUTO_REPORT_ENABLED"] = "false"

from fastapi.testclient import TestClient
from sqlalchemy import select

from app import state
from app.db import Base, SessionLocal, engine
from app.main import app
from app.models import Notification, PostureRecord, Report, ScheduledReportRun, Student, User, UserStudentLink
from app.services.auth import hash_secret
from app.services.game import CHINA_TZ
from app.services.scheduled_reports import due_periods, run_due_reports


def reset_scheduled_report_db():
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    state.latest.clear()
    state.history.clear()
    state.subscribers.clear()
    state.student_subscribers.clear()
    state.game_subscribers.clear()


def seed_student_with_record(local_dt: datetime):
    db = SessionLocal()
    db.add(User(user_id="USR-AUTO-PARENT", username="auto_parent", password_hash=hash_secret("parent123"), role="parent"))
    db.add(Student(student_id="STU-AUTO-001", display_code="STU-AUTO-001"))
    db.add(UserStudentLink(user_id="USR-AUTO-PARENT", student_id="STU-AUTO-001", relation="guardian"))
    timestamp_ms = int(local_dt.astimezone(timezone.utc).timestamp() * 1000)
    db.add(
        PostureRecord(
            device_id="SG-AUTO-001",
            student_id="STU-AUTO-001",
            session_id="AUTO-S1",
            seq=1,
            timestamp_ms=timestamp_ms,
            posture="normal",
            confidence=0.95,
            pressure_left=500,
            pressure_right=500,
            pressure_front=500,
            pressure_back=500,
            pressure_center=500,
            total_pressure=2500,
            left_right_diff=0,
            front_back_diff=0,
            center_x=0,
            center_y=0,
            asymmetry_index=0.05,
            tilt_x=0,
            tilt_y=0,
            shake_level=0,
            posture_duration_s=120,
            sitting_duration_s=120,
            vibration_enabled=True,
            warning_active=False,
            reminder_count=0,
            battery_level=90,
            recognition_source="mock",
            model_version="mock-v1",
            firmware_version="mock-v1",
        )
    )
    db.commit()
    db.close()


def test_due_period_boundaries_use_natural_week_and_month():
    before_daily = datetime(2026, 7, 15, 0, 9, tzinfo=CHINA_TZ)
    assert not any(item[0] == "daily" for item in due_periods(before_daily, 1))

    at_daily = datetime(2026, 7, 15, 0, 10, tzinfo=CHINA_TZ)
    daily = next(item for item in due_periods(at_daily, 1) if item[0] == "daily")
    assert daily[1].isoformat() == daily[2].isoformat() == "2026-07-14"

    monday = datetime(2026, 7, 20, 0, 20, tzinfo=CHINA_TZ)
    weekly = next(item for item in due_periods(monday, 1) if item[0] == "weekly")
    assert weekly[1].isoformat() == "2026-07-13"
    assert weekly[2].isoformat() == "2026-07-19"

    month_start = datetime(2026, 8, 1, 0, 30, tzinfo=CHINA_TZ)
    monthly = next(item for item in due_periods(month_start, 1) if item[0] == "monthly")
    assert monthly[1].isoformat() == "2026-07-01"
    assert monthly[2].isoformat() == "2026-07-31"


def test_daily_auto_report_is_idempotent_and_creates_visible_notification(monkeypatch):
    reset_scheduled_report_db()
    seed_student_with_record(datetime(2026, 7, 14, 12, 0, tzinfo=CHINA_TZ))
    monkeypatch.setattr(
        "app.services.scheduled_reports.generate_llm_report",
        lambda summary: "自动报告测试内容",
    )

    db = SessionLocal()
    now = datetime(2026, 7, 15, 0, 10, tzinfo=CHINA_TZ).astimezone(timezone.utc)
    first = run_due_reports(db, now=now, use_llm=True, catch_up_days=1)
    db.commit()
    second = run_due_reports(db, now=now, use_llm=True, catch_up_days=1)
    db.commit()
    assert len(first) == 1
    assert second == []
    assert first[0]["generated_by"] == "llm"
    report = db.scalar(select(Report))
    run = db.scalar(select(ScheduledReportRun))
    notification = db.scalar(select(Notification))
    assert report.report_type == "daily"
    assert report.period_start.isoformat() == report.period_end.isoformat() == "2026-07-14"
    assert report.content == "自动报告测试内容"
    assert run.status == "completed"
    assert run.report_id == report.id
    assert run.notification_id == notification.notification_id
    assert notification.notification_type == "report"
    assert notification.student_id == "STU-AUTO-001"
    summary = __import__("json").loads(report.summary_json)
    assert set(summary["posture_stats"]) == {
        "normal", "left_lean", "right_lean", "front_lean", "back_lean"
    }
    assert "reminder_peak_day" in summary
    assert "trend" in summary
    db.close()

    with TestClient(app) as client:
        login = client.post("/api/v1/auth/login", json={"username": "auto_parent", "password": "parent123"})
        headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
        notifications = client.get("/api/v1/notifications", headers=headers)
        assert notifications.status_code == 200
        assert notifications.json()["total"] == 1
        assert notifications.json()["items"][0]["title"] == "坐姿日报已生成"
        item = notifications.json()["items"][0]
        assert item["is_read"] is False
        assert item["related_report_id"] == first[0]["report_id"]
        detail = client.get(
            f"/api/v1/students/STU-AUTO-001/reports/{item['related_report_id']}",
            headers=headers,
        )
        assert detail.status_code == 200
        marked = client.post(f"/api/v1/notifications/{item['notification_id']}/read", headers=headers)
        assert marked.status_code == 200
        assert marked.json()["data"]["is_read"] is True


def test_auto_report_skips_empty_period_and_uses_rule_fallback(monkeypatch):
    reset_scheduled_report_db()
    db = SessionLocal()
    db.add(Student(student_id="STU-NO-DATA", display_code="STU-NO-DATA"))
    db.commit()
    now = datetime(2026, 7, 15, 0, 10, tzinfo=CHINA_TZ).astimezone(timezone.utc)
    assert run_due_reports(db, now=now, use_llm=True, catch_up_days=1) == []
    assert list(db.scalars(select(Report))) == []
    assert list(db.scalars(select(Notification))) == []
    db.close()

    reset_scheduled_report_db()
    seed_student_with_record(datetime(2026, 7, 14, 12, 0, tzinfo=CHINA_TZ))
    monkeypatch.setattr(
        "app.services.scheduled_reports.generate_llm_report",
        lambda summary: "【LLM 调用未完成】测试失败。" + __import__(
            "app.services.reports", fromlist=["rule_report_content"]
        ).rule_report_content(summary),
    )
    db = SessionLocal()
    result = run_due_reports(db, now=now, use_llm=True, catch_up_days=1)
    db.commit()
    assert result[0]["generated_by"] == "llm_fallback"
    assert db.scalar(select(Report)).generated_by == "llm_fallback"
    assert db.scalar(select(Notification)) is not None
    db.close()
