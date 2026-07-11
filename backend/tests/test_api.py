import os
from pathlib import Path

TEST_DB_PATH = Path(__file__).resolve().parents[1] / "test_spineguard.db"
os.environ["DATABASE_URL"] = f"sqlite:///{TEST_DB_PATH.as_posix()}"

from fastapi.testclient import TestClient
from app import state
from app.db import Base, engine
from app.main import app


def reset_db():
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    state.latest.clear()
    state.history.clear()
    state.subscribers.clear()


def test_round_trip():
    reset_db()

    payload = {
        "protocol_version":1,"device_id":"SG-0001","session_id":"T1","seq":1,
        "timestamp_ms":1,"posture":"normal","confidence":0.95,
        "pressure":{"left":500,"right":510,"front":400,"back":600,"center":700},
        "pressure_features":{
            "total_pressure":2710,"left_right_diff":-10,"front_back_diff":-200,
            "center_x":-0.01,"center_y":-0.16,"asymmetry_index":0.08
        },
        "imu":{"tilt_x":0.0,"tilt_y":0.0,"shake_level":0.0},
        "posture_duration_s":5,"sitting_duration_s":30,
        "vibration_enabled":True,"warning_active":False,
        "reminder_count":0,"battery_level":100,
        "recognition_source":"mock","model_version":"mock-v0.1","firmware_version":"0.1.0"
    }
    with TestClient(app) as client:
        r = client.post("/api/v1/device/telemetry", headers={"X-Device-Token":"dev-token"}, json=payload)
        assert r.status_code == 200
        r = client.get("/api/v1/devices/SG-0001/latest")
        assert r.json()["data"]["posture"] == "normal"
        r = client.get("/api/v1/devices/SG-0001/history")
        assert r.json()["items"][0]["pressure_features"]["total_pressure"] == 2710


def test_database_tables_created():
    reset_db()

    table_names = set(Base.metadata.tables)
    assert {
        "users",
        "students",
        "user_student_links",
        "devices",
        "device_bindings",
        "posture_records",
        "daily_stats",
        "risk_assessments",
        "reports",
        "reminder_events",
    }.issubset(table_names)
