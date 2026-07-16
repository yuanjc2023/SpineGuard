import os
from datetime import datetime, timedelta, timezone
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
from app.models import (
    AbnormalEpisode,
    Device,
    DeviceBinding,
    DeviceSessionState,
    GameDailyProgress,
    GardenAccount,
    MilestoneClaim,
    PostureRecord,
    RewardLedger,
    Student,
    TelemetryReceipt,
    User,
    UserStudentLink,
)
from app.services.auth import hash_secret
from app.services.game import CHINA_TZ, expire_offline_sessions, settle_due_growth


def reset_game_db():
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    state.latest.clear()
    state.history.clear()
    state.subscribers.clear()
    state.student_subscribers.clear()
    state.game_subscribers.clear()


def seed_bound_student(device_id: str = "SG-GAME-001"):
    db = SessionLocal()
    db.add(User(user_id="USR-GAME-PARENT", username="game_parent", password_hash=hash_secret("parent123"), role="parent"))
    db.add(Student(student_id="STU-GAME-001", display_code="STU-GAME-001"))
    db.add(UserStudentLink(user_id="USR-GAME-PARENT", student_id="STU-GAME-001", relation="guardian"))
    db.add(Device(device_id=device_id, device_token_hash=hash_secret("device-secret"), online_status="unknown"))
    db.add(DeviceBinding(device_id=device_id, student_id="STU-GAME-001", bound_by_user_id="USR-GAME-PARENT", active=True))
    db.commit()
    db.close()


def login_headers(client: TestClient) -> dict:
    response = client.post("/api/v1/auth/login", json={"username": "game_parent", "password": "parent123"})
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def payload(seq: int, timestamp_ms: int, posture: str = "normal", session_id: str = "GAME-S1") -> dict:
    return {
        "protocol_version": 2,
        "device_id": "SG-GAME-001",
        "session_id": session_id,
        "seq": seq,
        "timestamp_ms": timestamp_ms,
        "posture": posture,
        "confidence": 0.95,
        "pressure": {"left": 500, "right": 510, "front": 400, "back": 600, "center": 700},
        "raw_pressure": {"left": 2048, "right": 2006, "front": 2457, "back": 1638, "center": 1228},
        "pressure_features": {
            "total_pressure": 2710,
            "left_right_diff": -10,
            "front_back_diff": -200,
            "center_x": -0.01,
            "center_y": -0.16,
            "asymmetry_index": 0.08,
        },
        "imu": {"tilt_x": 0.0, "tilt_y": 0.0, "shake_level": 0.0},
        "posture_duration_s": 2,
        "sitting_duration_s": seq * 2,
        "vibration_enabled": True,
        "warning_active": posture not in {"normal", "empty", "unknown"},
        "reminder_count": 0,
        "battery_level": 88,
        "recognition_source": "mock",
        "model_version": "mock-v0.1",
        "firmware_version": "0.1.0",
    }


def upload(client: TestClient, data: dict):
    return client.post("/api/v1/device/telemetry", headers={"X-Device-Token": "dev-token"}, json=data)


def test_game_rules_garden_and_duplicate_telemetry():
    reset_game_db()
    seed_bound_student()
    base_ms = 1783958400000
    with TestClient(app) as client:
        headers = login_headers(client)
        rules = client.get("/api/v1/game/rules", headers=headers)
        assert rules.status_code == 200
        assert rules.json()["data"]["thresholds"]["growth_settlement_local_time"] == "20:00"
        assert rules.json()["data"]["focus_mode_backend_enabled"] is False

        first = upload(client, payload(1, base_ms))
        duplicate = upload(client, payload(1, base_ms))
        assert first.json()["duplicate"] is False
        assert duplicate.json()["duplicate"] is True

        garden = client.get("/api/v1/students/STU-GAME-001/garden", headers=headers)
        assert garden.status_code == 200
        data = garden.json()["data"]
        assert data["stage"] == "seed"
        assert data["today_normal_s"] == 0
        assert "health" not in str(data).lower()

    db = SessionLocal()
    assert len(list(db.scalars(select(PostureRecord)))) == 1
    assert len(list(db.scalars(select(TelemetryReceipt)))) == 1
    db.close()


def test_abnormal_episode_reminds_and_resets_once_then_recovers():
    reset_game_db()
    seed_bound_student()
    base_ms = 1783958400000
    with TestClient(app) as client:
        upload(client, payload(1, base_ms, "normal"))
        upload(client, payload(2, base_ms + 2_000, "left_lean"))
        seq = 3
        for elapsed_s in range(4, 66, 2):
            upload(client, payload(seq, base_ms + elapsed_s * 1000, "front_lean" if elapsed_s >= 20 else "left_lean"))
            seq += 1
        upload(client, payload(seq, base_ms + 66_000, "normal"))
        seq += 1
        for elapsed_s in (68, 70, 72):
            upload(client, payload(seq, base_ms + elapsed_s * 1000, "normal"))
            seq += 1

    db = SessionLocal()
    episode = db.scalar(select(AbnormalEpisode))
    session = db.scalar(select(DeviceSessionState))
    account = db.scalar(select(GardenAccount))
    assert episode.reminded is True
    assert episode.continuous_reset is True
    assert session.reminder_count == 1
    assert session.abnormal_episode_id is None
    assert account.recovery_needed is True
    db.close()


def test_continuous_milestone_task_claim_and_action_are_idempotent():
    reset_game_db()
    seed_bound_student()
    local_now = datetime.now(timezone.utc).astimezone(CHINA_TZ)
    base_ms = int(local_now.replace(hour=8, minute=0, second=0, microsecond=0).timestamp() * 1000)
    with TestClient(app) as client:
        headers = login_headers(client)
        upload(client, payload(1, base_ms))
        seq = 2
        for elapsed_s in range(10, 1511, 10):
            upload(client, payload(seq, base_ms + elapsed_s * 1000))
            seq += 1

        garden = client.get("/api/v1/students/STU-GAME-001/garden", headers=headers).json()["data"]
        assert garden["continuous_normal_s"] >= 1500
        assert garden["resources"] == {"sunshine": 1, "water": 3, "nutrient": 0}
        task = next(item for item in garden["tasks"] if item["task_id"] == "continuous_25")
        assert task["status"] == "claimable"

        body = {"idempotency_key": "claim-continuous-25-001"}
        claimed = client.post(
            "/api/v1/students/STU-GAME-001/daily-tasks/continuous_25/claim",
            headers=headers,
            json=body,
        )
        repeated = client.post(
            "/api/v1/students/STU-GAME-001/daily-tasks/continuous_25/claim",
            headers=headers,
            json=body,
        )
        assert claimed.status_code == repeated.status_code == 200
        assert repeated.json()["data"]["resources"] == {"sunshine": 4, "water": 6, "nutrient": 0}

        action_body = {"action": "water", "quantity": 1, "idempotency_key": "garden-water-action-001"}
        watered = client.post("/api/v1/students/STU-GAME-001/garden/actions", headers=headers, json=action_body)
        watered_again = client.post("/api/v1/students/STU-GAME-001/garden/actions", headers=headers, json=action_body)
        assert watered.status_code == watered_again.status_code == 200
        assert watered_again.json()["data"]["growth"] == 15
        assert watered_again.json()["data"]["resources"]["water"] == 1

    db = SessionLocal()
    assert len(list(db.scalars(select(MilestoneClaim)))) == 2
    action_ledgers = list(db.scalars(select(RewardLedger).where(RewardLedger.source_type == "resource_action")))
    assert len(action_ledgers) == 1
    db.close()


def test_growth_settlement_at_20_and_offline_thresholds():
    reset_game_db()
    seed_bound_student()
    local_day = datetime(2026, 7, 13, 0, 0, tzinfo=CHINA_TZ).date()
    db = SessionLocal()
    db.add(
        GameDailyProgress(
            student_id="STU-GAME-001",
            local_date=local_day,
            normal_s=3600,
            effective_measurement_s=3600,
            reminder_count=6,
        )
    )
    db.commit()
    before = datetime(2026, 7, 13, 19, 59, tzinfo=CHINA_TZ).astimezone(timezone.utc)
    assert settle_due_growth(db, before) == []
    at_twenty = datetime(2026, 7, 13, 20, 0, tzinfo=CHINA_TZ).astimezone(timezone.utc)
    settled = settle_due_growth(db, at_twenty)
    db.commit()
    assert settled[0]["performance_factor"] == 0.9
    assert settled[0]["granted_growth"] == 54
    assert settle_due_growth(db, at_twenty + timedelta(minutes=1)) == []

    now = datetime.now(timezone.utc)
    session = DeviceSessionState(
        device_id="SG-GAME-001",
        student_id="STU-GAME-001",
        device_session_id="OFFLINE-S1",
        started_at_ms=1,
        last_telemetry_at_ms=1,
        last_received_at=now - timedelta(seconds=11),
        current_posture="normal",
        current_posture_since_ms=1,
        last_seq=1,
    )
    db.add(session)
    db.commit()
    expire_offline_sessions(db, now)
    db.commit()
    assert db.scalar(select(Device).where(Device.device_id == "SG-GAME-001")).online_status == "offline"
    assert session.status == "active"
    expire_offline_sessions(db, now + timedelta(minutes=5))
    db.commit()
    assert session.status == "offline_timeout"
    db.close()


def test_one_student_can_only_have_one_active_device_binding():
    reset_game_db()
    seed_bound_student("SG-GAME-001")
    db = SessionLocal()
    db.add(Device(device_id="SG-GAME-002", device_token_hash=hash_secret("device-secret"), online_status="unknown"))
    db.commit()
    db.close()

    with TestClient(app) as client:
        headers = login_headers(client)
        response = client.post(
            "/api/v1/devices/bind",
            headers=headers,
            json={"device_id": "SG-GAME-002", "student_id": "STU-GAME-001", "bind_code": "123456"},
        )
        assert response.status_code == 200

    db = SessionLocal()
    active = list(db.scalars(select(DeviceBinding).where(DeviceBinding.student_id == "STU-GAME-001", DeviceBinding.active.is_(True))))
    assert [item.device_id for item in active] == ["SG-GAME-002"]
    db.close()
