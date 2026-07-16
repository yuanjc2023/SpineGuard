import os
from pathlib import Path
from io import BytesIO
from zipfile import ZipFile

TEST_DB_PATH = Path(
    os.getenv(
        "SPINEGUARD_TEST_DB_PATH",
        str(Path(__file__).resolve().parents[1] / "test_spineguard.db"),
    )
)
os.environ["DATABASE_URL"] = f"sqlite:///{TEST_DB_PATH.as_posix()}"
os.environ["AUTO_REPORT_ENABLED"] = "false"

from fastapi.testclient import TestClient
from app import state
from app.db import Base, engine
from app.main import app
from app.models import Device, DeviceBinding, PostureRecord, Student, User, UserStudentLink
from app.services.auth import hash_secret


def reset_db():
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    state.latest.clear()
    state.history.clear()
    state.subscribers.clear()
    state.student_subscribers.clear()


def seed_user(user_id: str, username: str, password: str, role: str):
    from app.db import SessionLocal

    db = SessionLocal()
    db.add(User(user_id=user_id, username=username, password_hash=hash_secret(password), role=role))
    db.commit()
    db.close()


def telemetry_payload(
    device_id: str = "SG-0001",
    seq: int = 1,
    timestamp_ms: int | None = None,
    posture: str = "normal",
    posture_duration_s: int = 5,
    reminder_count: int = 0,
    asymmetry_index: float = 0.08,
):
    return {
        "protocol_version":2,"device_id":device_id,"session_id":"T1","seq":seq,
        "timestamp_ms":timestamp_ms if timestamp_ms is not None else seq,"posture":posture,"confidence":0.95,
        "pressure":{"left":500,"right":510,"front":400,"back":600,"center":700},
        "raw_pressure":{"left":2048,"right":2006,"front":2457,"back":1638,"center":1228},
        "pressure_features":{
            "total_pressure":2710,"left_right_diff":-10,"front_back_diff":-200,
            "center_x":-0.01,"center_y":-0.16,"asymmetry_index":asymmetry_index
        },
        "imu":{"tilt_x":0.0,"tilt_y":0.0,"shake_level":0.0},
        "posture_duration_s":posture_duration_s,"sitting_duration_s":30,
        "vibration_enabled":True,"warning_active":False,
        "reminder_count":reminder_count,"battery_level":88,
        "recognition_source":"mock","model_version":"mock-v0.1","firmware_version":"0.1.0"
    }


def test_round_trip():
    reset_db()

    payload = telemetry_payload()
    with TestClient(app) as client:
        r = client.post("/api/v1/device/telemetry", headers={"X-Device-Token":"dev-token"}, json=payload)
        assert r.status_code == 200
        r = client.get("/api/v1/devices/SG-0001/latest")
        assert r.json()["data"]["posture"] == "normal"
        r = client.get("/api/v1/devices/SG-0001/history")
        assert r.json()["items"][0]["pressure_features"]["total_pressure"] == 2710
        assert r.json()["items"][0]["raw_pressure"]["left"] == 2048


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
        "scheduled_report_runs",
        "reminder_events",
        "notifications",
        "telemetry_receipts",
        "device_session_states",
        "abnormal_episodes",
        "growth_settlement_segments",
        "garden_accounts",
        "game_daily_progress",
        "reward_ledger",
        "milestone_claims",
        "daily_task_states",
        "idempotency_records",
    }.issubset(table_names)


def test_auth_students_devices_flow():
    reset_db()
    seed_user("USR-DEMO-PARENT", "parent_demo", "parent123", "parent")
    seed_user("USR-DEMO-ADMIN", "school_admin_demo", "admin123", "school_admin")

    with TestClient(app) as client:
        bad = client.post("/api/v1/auth/login", json={"username": "parent_demo", "password": "wrong"})
        assert bad.status_code == 401

        parent_login = client.post("/api/v1/auth/login", json={"username": "parent_demo", "password": "parent123"})
        assert parent_login.status_code == 200
        parent_token = parent_login.json()["access_token"]
        parent_headers = {"Authorization": f"Bearer {parent_token}"}

        me = client.get("/api/v1/auth/me", headers=parent_headers)
        assert me.json()["data"]["role"] == "parent"
        me_compat = client.get("/api/v1/me", headers=parent_headers)
        assert me_compat.json()["data"]["role"] == "parent"

        student = client.post(
            "/api/v1/students",
            headers=parent_headers,
            json={"display_code": "STU-DEMO-LOCAL", "school_id": "SCH-DEMO", "class_id": "CLASS-DEMO"},
        )
        assert student.status_code == 200
        student_id = student.json()["data"]["student_id"]

        admin_login = client.post("/api/v1/auth/login", json={"username": "school_admin_demo", "password": "admin123"})
        admin_token = admin_login.json()["access_token"]
        admin_headers = {"Authorization": f"Bearer {admin_token}"}

        device = client.post(
            "/api/v1/devices",
            headers=admin_headers,
            json={"device_id": "SG-TEST-001", "device_token": "device-secret", "firmware_version": "0.1.0"},
        )
        assert device.status_code == 200

        binding = client.post(
            "/api/v1/devices/bind",
            headers=parent_headers,
            json={"device_id": "SG-TEST-001", "student_id": student_id, "bind_code": "123456"},
        )
        assert binding.status_code == 200
        assert binding.json()["data"]["active"] is True

        devices = client.get("/api/v1/devices", headers=parent_headers)
        assert devices.json()["total"] == 1


def test_bound_device_telemetry_is_queryable_by_student():
    reset_db()
    seed_user("USR-DEMO-PARENT", "parent_demo", "parent123", "parent")
    seed_user("USR-OTHER-PARENT", "other_parent", "parent123", "parent")

    from app.db import SessionLocal

    db = SessionLocal()
    db.add(Student(student_id="STU-DEMO-001", display_code="STU-DEMO-001", school_id="SCH-DEMO", class_id="CLASS-DEMO"))
    db.add(UserStudentLink(user_id="USR-DEMO-PARENT", student_id="STU-DEMO-001", relation="guardian"))
    db.add(Device(device_id="SG-BOUND-001", device_token_hash=hash_secret("device-secret"), online_status="unknown"))
    db.add(DeviceBinding(device_id="SG-BOUND-001", student_id="STU-DEMO-001", bound_by_user_id="USR-DEMO-PARENT", active=True))
    db.commit()
    db.close()

    with TestClient(app) as client:
        r = client.post("/api/v1/device/telemetry", headers={"X-Device-Token":"dev-token"}, json=telemetry_payload("SG-BOUND-001"))
        assert r.status_code == 200

        parent_login = client.post("/api/v1/auth/login", json={"username": "parent_demo", "password": "parent123"})
        parent_headers = {"Authorization": f"Bearer {parent_login.json()['access_token']}"}

        latest = client.get("/api/v1/students/STU-DEMO-001/latest", headers=parent_headers)
        assert latest.status_code == 200
        assert latest.json()["data"]["device_id"] == "SG-BOUND-001"
        assert latest.json()["data"]["student_id"] == "STU-DEMO-001"

        history = client.get("/api/v1/students/STU-DEMO-001/history", headers=parent_headers)
        assert history.status_code == 200
        assert history.json()["items"][0]["student_id"] == "STU-DEMO-001"

        filtered = client.get(
            "/api/v1/students/STU-DEMO-001/history?from=1970-01-02&to=1970-01-03",
            headers=parent_headers,
        )
        assert filtered.status_code == 200
        assert filtered.json()["items"] == []

        other_login = client.post("/api/v1/auth/login", json={"username": "other_parent", "password": "parent123"})
        other_headers = {"Authorization": f"Bearer {other_login.json()['access_token']}"}
        forbidden = client.get("/api/v1/students/STU-DEMO-001/latest", headers=other_headers)
        assert forbidden.status_code == 403

    db = SessionLocal()
    record = db.query(PostureRecord).filter_by(device_id="SG-BOUND-001").one()
    device = db.query(Device).filter_by(device_id="SG-BOUND-001").one()
    assert record.student_id == "STU-DEMO-001"
    assert device.online_status == "online"
    assert device.battery_level == 88
    db.close()


def test_daily_stats_are_calculated_and_persisted():
    reset_db()
    seed_user("USR-DEMO-PARENT", "parent_demo", "parent123", "parent")

    from app.db import SessionLocal

    db = SessionLocal()
    db.add(Student(student_id="STU-DEMO-001", display_code="STU-DEMO-001", school_id="SCH-DEMO", class_id="CLASS-DEMO"))
    db.add(UserStudentLink(user_id="USR-DEMO-PARENT", student_id="STU-DEMO-001", relation="guardian"))
    db.add(Device(device_id="SG-STATS-001", device_token_hash=hash_secret("device-secret"), online_status="unknown"))
    db.add(DeviceBinding(device_id="SG-STATS-001", student_id="STU-DEMO-001", bound_by_user_id="USR-DEMO-PARENT", active=True))
    db.commit()
    db.close()

    with TestClient(app) as client:
        client.post(
            "/api/v1/device/telemetry",
            headers={"X-Device-Token":"dev-token"},
            json=telemetry_payload("SG-STATS-001", seq=1, timestamp_ms=1783785600000, posture="normal", posture_duration_s=120, asymmetry_index=0.1),
        )
        client.post(
            "/api/v1/device/telemetry",
            headers={"X-Device-Token":"dev-token"},
            json=telemetry_payload("SG-STATS-001", seq=2, timestamp_ms=1783785660000, posture="left_lean", posture_duration_s=45, reminder_count=2, asymmetry_index=0.4),
        )

        login = client.post("/api/v1/auth/login", json={"username": "parent_demo", "password": "parent123"})
        headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
        stat = client.get("/api/v1/students/STU-DEMO-001/stats/daily?date=2026-07-12", headers=headers)
        assert stat.status_code == 200
        data = stat.json()["data"]
        assert data["normal_sitting_s"] == 60
        assert data["poor_sitting_s"] == 45
        assert data["left_lean_count"] == 1
        assert data["reminder_count"] == 2
        assert data["avg_asymmetry_index"] == 0.25

        weekly = client.get("/api/v1/students/STU-DEMO-001/stats/weekly?week=2026-W28", headers=headers)
        assert weekly.status_code == 200
        weekly_data = weekly.json()["data"]
        assert weekly_data["normal_sitting_s"] == 60
        assert weekly_data["poor_sitting_s"] == 45
        assert weekly_data["week"] == "2026-W28"
        assert len(weekly_data["daily_items"]) == 7


def test_risk_and_report_endpoints_use_screening_language(monkeypatch):
    reset_db()
    seed_user("USR-DEMO-PARENT", "parent_demo", "parent123", "parent")
    monkeypatch.setattr("app.services.reports.LLM_API_KEY", "")
    monkeypatch.setattr("app.services.reports.LLM_API_BASE", "")
    monkeypatch.setattr("app.services.reports.LLM_MODEL", "placeholder-model")

    from app.db import SessionLocal

    db = SessionLocal()
    db.add(Student(student_id="STU-RISK-001", display_code="STU-RISK-001", school_id="SCH-DEMO", class_id="CLASS-DEMO"))
    db.add(UserStudentLink(user_id="USR-DEMO-PARENT", student_id="STU-RISK-001", relation="guardian"))
    db.add(Device(device_id="SG-RISK-001", device_token_hash=hash_secret("device-secret"), online_status="unknown"))
    db.add(DeviceBinding(device_id="SG-RISK-001", student_id="STU-RISK-001", bound_by_user_id="USR-DEMO-PARENT", active=True))
    db.commit()
    db.close()

    with TestClient(app) as client:
        client.post(
            "/api/v1/device/telemetry",
            headers={"X-Device-Token":"dev-token"},
            json=telemetry_payload("SG-RISK-001", seq=1, timestamp_ms=1783785600000, posture="normal", posture_duration_s=60, asymmetry_index=0.2),
        )
        client.post(
            "/api/v1/device/telemetry",
            headers={"X-Device-Token":"dev-token"},
            json=telemetry_payload("SG-RISK-001", seq=2, timestamp_ms=1783785660000, posture="left_lean", posture_duration_s=360, reminder_count=12, asymmetry_index=0.6),
        )

        login = client.post("/api/v1/auth/login", json={"username": "parent_demo", "password": "parent123"})
        headers = {"Authorization": f"Bearer {login.json()['access_token']}"}

        risk = client.get("/api/v1/students/STU-RISK-001/risk?date=2026-07-12", headers=headers)
        assert risk.status_code == 200
        assert risk.json()["data"]["risk_level"] == "red"
        assert "诊断" not in risk.json()["data"]["suggestion"]

        report = client.post(
            "/api/v1/students/STU-RISK-001/reports/generate",
            headers=headers,
            json={"report_type": "daily", "use_llm": False, "date": "2026-07-12"},
        )
        assert report.status_code == 200
        assert report.json()["data"]["generated_by"] == "rule"
        assert "坐姿行为风险提示" in report.json()["data"]["content"]

        llm_report = client.post(
            "/api/v1/students/STU-RISK-001/reports/generate",
            headers=headers,
            json={"report_type": "weekly", "use_llm": True, "date": "2026-07-12"},
        )
        assert llm_report.status_code == 200
        assert llm_report.json()["data"]["generated_by"] == "llm_fallback"
        assert "LLM 调用未完成" in llm_report.json()["data"]["content"]

        reports = client.get("/api/v1/students/STU-RISK-001/reports", headers=headers)
        assert reports.status_code == 200
        assert reports.json()["total"] == 2


def test_device_history_time_filters():
    reset_db()

    with TestClient(app) as client:
        client.post(
            "/api/v1/device/telemetry",
            headers={"X-Device-Token":"dev-token"},
            json=telemetry_payload("SG-FILTER-001", seq=1, timestamp_ms=1000),
        )
        client.post(
            "/api/v1/device/telemetry",
            headers={"X-Device-Token":"dev-token"},
            json=telemetry_payload("SG-FILTER-001", seq=2, timestamp_ms=2000),
        )
        history = client.get("/api/v1/devices/SG-FILTER-001/history?from=1500&to=2500")
        assert history.status_code == 200
        assert len(history.json()["items"]) == 1
        assert history.json()["items"][0]["seq"] == 2

        bad = client.get("/api/v1/devices/SG-FILTER-001/history?from=bad-time")
        assert bad.status_code == 400


def test_student_websocket_and_admin_export():
    reset_db()
    seed_user("USR-DEMO-PARENT", "parent_demo", "parent123", "parent")
    seed_user("USR-DEMO-ADMIN", "school_admin_demo", "admin123", "school_admin")

    from app.db import SessionLocal

    db = SessionLocal()
    db.add(Student(student_id="STU-WS-001", display_code="STU-WS-001", school_id="SCH-DEMO", class_id="CLASS-DEMO"))
    db.add(UserStudentLink(user_id="USR-DEMO-PARENT", student_id="STU-WS-001", relation="guardian"))
    db.add(Device(device_id="SG-WS-001", device_token_hash=hash_secret("device-secret"), online_status="unknown"))
    db.add(DeviceBinding(device_id="SG-WS-001", student_id="STU-WS-001", bound_by_user_id="USR-DEMO-PARENT", active=True))
    db.commit()
    db.close()

    with TestClient(app) as client:
        parent_login = client.post("/api/v1/auth/login", json={"username": "parent_demo", "password": "parent123"})
        parent_token = parent_login.json()["access_token"]
        admin_login = client.post("/api/v1/auth/login", json={"username": "school_admin_demo", "password": "admin123"})
        admin_headers = {"Authorization": f"Bearer {admin_login.json()['access_token']}"}

        with client.websocket_connect(f"/api/v1/ws/students/STU-WS-001?token={parent_token}") as websocket:
            client.post(
                "/api/v1/device/telemetry",
                headers={"X-Device-Token":"dev-token"},
                json=telemetry_payload("SG-WS-001", seq=1, timestamp_ms=1783785600000),
            )
            pushed = websocket.receive_json()
            assert pushed["student_id"] == "STU-WS-001"
            assert pushed["device_id"] == "SG-WS-001"

        overview = client.get("/api/v1/admin/overview", headers=admin_headers)
        assert overview.status_code == 200
        assert overview.json()["data"]["student_count"] == 1
        assert overview.json()["data"]["device_count"] == 1

        classes = client.get("/api/v1/admin/classes", headers=admin_headers)
        assert classes.status_code == 200
        assert classes.json()["items"][0]["class_id"] == "CLASS-DEMO"

        class_detail = client.get("/api/v1/admin/classes/CLASS-DEMO/students", headers=admin_headers)
        assert class_detail.status_code == 200
        assert class_detail.json()["items"][0]["student_id"] == "STU-WS-001"

        export = client.get("/api/v1/admin/export?from=2026-07-11&to=2026-07-11", headers=admin_headers)
        assert export.status_code == 200
        assert "student_id,device_id,session_id" in export.text
        assert "SG-WS-001" in export.text

        excel = client.get("/api/v1/admin/export?from=2026-07-11&to=2026-07-11&format=xlsx", headers=admin_headers)
        assert excel.status_code == 200
        assert excel.headers["content-type"] == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        with ZipFile(BytesIO(excel.content)) as workbook:
            assert "xl/worksheets/sheet1.xml" in workbook.namelist()
            sheet = workbook.read("xl/worksheets/sheet1.xml").decode("utf-8")
            assert "SG-WS-001" in sheet


def test_admin_risk_students_and_notifications():
    reset_db()
    seed_user("USR-DEMO-PARENT", "parent_demo", "parent123", "parent")
    seed_user("USR-DEMO-ADMIN", "school_admin_demo", "admin123", "school_admin")

    from app.db import SessionLocal

    db = SessionLocal()
    db.add(Student(student_id="STU-NOTIFY-001", display_code="STU-NOTIFY-001", school_id="SCH-DEMO", class_id="CLASS-DEMO"))
    db.add(UserStudentLink(user_id="USR-DEMO-PARENT", student_id="STU-NOTIFY-001", relation="guardian"))
    db.add(Device(device_id="SG-NOTIFY-001", device_token_hash=hash_secret("device-secret"), online_status="unknown"))
    db.add(DeviceBinding(device_id="SG-NOTIFY-001", student_id="STU-NOTIFY-001", bound_by_user_id="USR-DEMO-PARENT", active=True))
    db.commit()
    db.close()

    with TestClient(app) as client:
        client.post(
            "/api/v1/device/telemetry",
            headers={"X-Device-Token":"dev-token"},
            json=telemetry_payload("SG-NOTIFY-001", seq=1, timestamp_ms=1783785600000, posture="left_lean", posture_duration_s=360, reminder_count=12, asymmetry_index=0.6),
        )

        parent_login = client.post("/api/v1/auth/login", json={"username": "parent_demo", "password": "parent123"})
        parent_headers = {"Authorization": f"Bearer {parent_login.json()['access_token']}"}
        admin_login = client.post("/api/v1/auth/login", json={"username": "school_admin_demo", "password": "admin123"})
        admin_headers = {"Authorization": f"Bearer {admin_login.json()['access_token']}"}

        risk = client.get("/api/v1/students/STU-NOTIFY-001/risk?date=2026-07-12", headers=parent_headers)
        assert risk.status_code == 200
        assert risk.json()["data"]["risk_level"] == "red"

        risk_students = client.get("/api/v1/admin/risk-students?risk_level=red", headers=admin_headers)
        assert risk_students.status_code == 200
        assert risk_students.json()["items"][0]["student_id"] == "STU-NOTIFY-001"

        risk_export = client.get(
            "/api/v1/admin/risk-students/export?risk_level=red&from=2026-07-11&to=2026-07-11",
            headers=admin_headers,
        )
        assert risk_export.status_code == 200
        assert risk_export.headers["content-type"] == "application/zip"
        with ZipFile(BytesIO(risk_export.content)) as archive:
            names = archive.namelist()
            assert len(names) == 1
            assert names[0].startswith("STU-NOTIFY-001_")
            assert names[0].endswith(".xlsx")
            with ZipFile(BytesIO(archive.read(names[0]))) as workbook:
                sheet = workbook.read("xl/worksheets/sheet1.xml").decode("utf-8")
                assert "left_lean" in sheet
                assert "normal" not in sheet

        created = client.post(
            "/api/v1/notifications",
            headers=admin_headers,
            json={
                "student_id": "STU-NOTIFY-001",
                "notification_type": "risk",
                "title": "坐姿风险提示",
                "content": "请关注近期坐姿行为风险提示。",
            },
        )
        assert created.status_code == 200
        notification_id = created.json()["data"]["notification_id"]

        notifications = client.get("/api/v1/notifications", headers=parent_headers)
        assert notifications.status_code == 200
        assert notifications.json()["total"] == 1
        assert notifications.json()["items"][0]["is_read"] is False

        read = client.post(f"/api/v1/notifications/{notification_id}/read", headers=parent_headers)
        assert read.status_code == 200
        assert read.json()["data"]["is_read"] is True


def test_session_level_stats_use_time_slices():
    reset_db()
    seed_user("USR-DEMO-PARENT", "parent_demo", "parent123", "parent")

    from app.db import SessionLocal

    db = SessionLocal()
    db.add(Student(student_id="STU-SESSION-001", display_code="STU-SESSION-001", school_id="SCH-DEMO", class_id="CLASS-DEMO"))
    db.add(UserStudentLink(user_id="USR-DEMO-PARENT", student_id="STU-SESSION-001", relation="guardian"))
    db.add(Device(device_id="SG-SESSION-001", device_token_hash=hash_secret("device-secret"), online_status="unknown"))
    db.add(DeviceBinding(device_id="SG-SESSION-001", student_id="STU-SESSION-001", bound_by_user_id="USR-DEMO-PARENT", active=True))
    db.commit()
    db.close()

    with TestClient(app) as client:
        client.post(
            "/api/v1/device/telemetry",
            headers={"X-Device-Token":"dev-token"},
            json=telemetry_payload("SG-SESSION-001", seq=1, timestamp_ms=1783785600000, posture="normal", posture_duration_s=5),
        )
        client.post(
            "/api/v1/device/telemetry",
            headers={"X-Device-Token":"dev-token"},
            json=telemetry_payload("SG-SESSION-001", seq=2, timestamp_ms=1783785620000, posture="left_lean", posture_duration_s=5),
        )
        client.post(
            "/api/v1/device/telemetry",
            headers={"X-Device-Token":"dev-token"},
            json=telemetry_payload("SG-SESSION-001", seq=3, timestamp_ms=1783785650000, posture="normal", posture_duration_s=5),
        )
        login = client.post("/api/v1/auth/login", json={"username": "parent_demo", "password": "parent123"})
        headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
        stat = client.get("/api/v1/students/STU-SESSION-001/stats/daily?date=2026-07-12", headers=headers)
        assert stat.status_code == 200
        data = stat.json()["data"]
        assert data["normal_sitting_s"] == 25
        assert data["poor_sitting_s"] == 30
        assert data["max_poor_posture_duration_s"] == 30


def test_llm_report_uses_real_api_shape(monkeypatch):
    reset_db()
    seed_user("USR-DEMO-PARENT", "parent_demo", "parent123", "parent")

    monkeypatch.setattr("app.services.reports.LLM_API_KEY", "test-key")
    monkeypatch.setattr("app.services.reports.LLM_API_BASE", "https://llm.example/v1")
    monkeypatch.setattr("app.services.reports.LLM_MODEL", "test-model")

    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def read(self):
            return b'{"choices":[{"message":{"content":"LLM report ok"}}]}'

    def fake_urlopen(req, timeout):
        assert req.full_url == "https://llm.example/v1/chat/completions"
        assert req.headers["Authorization"] == "Bearer test-key"
        return FakeResponse()

    monkeypatch.setattr("app.services.reports.request.urlopen", fake_urlopen)

    from app.db import SessionLocal

    db = SessionLocal()
    db.add(Student(student_id="STU-LLM-001", display_code="STU-LLM-001", school_id="SCH-DEMO", class_id="CLASS-DEMO"))
    db.add(UserStudentLink(user_id="USR-DEMO-PARENT", student_id="STU-LLM-001", relation="guardian"))
    db.commit()
    db.close()

    with TestClient(app) as client:
        login = client.post("/api/v1/auth/login", json={"username": "parent_demo", "password": "parent123"})
        headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
        report = client.post(
            "/api/v1/students/STU-LLM-001/reports/generate",
            headers=headers,
            json={"report_type": "daily", "use_llm": True, "date": "2026-07-11"},
        )
        assert report.status_code == 200
        assert report.json()["data"]["generated_by"] == "llm"
        assert report.json()["data"]["content"] == "LLM report ok"


def test_default_smart_report_uses_latest_600_records(monkeypatch):
    reset_db()
    seed_user("USR-SMART-PARENT", "smart_parent", "parent123", "parent")
    captured = {}

    def fake_llm(payload, report_mode="scheduled", fallback_summary=None):
        captured["payload"] = payload
        captured["report_mode"] = report_mode
        captured["fallback_summary"] = fallback_summary
        return "最近600条智能报告"

    monkeypatch.setattr("app.services.reports.generate_llm_report", fake_llm)

    from app.db import SessionLocal

    db = SessionLocal()
    db.add(Student(student_id="STU-SMART-001", display_code="STU-SMART-001"))
    db.add(UserStudentLink(user_id="USR-SMART-PARENT", student_id="STU-SMART-001", relation="guardian"))
    base_ms = 1784160000000
    postures = ["normal", "left_lean", "right_lean", "front_lean", "back_lean"]
    for seq in range(650):
        posture = postures[seq % len(postures)]
        item = telemetry_payload(
            device_id="SG-SMART-001",
            seq=seq,
            timestamp_ms=base_ms + seq * 2000,
            posture=posture,
            posture_duration_s=2,
            reminder_count=seq // 100,
        )
        db.add(PostureRecord(
            device_id=item["device_id"], student_id="STU-SMART-001", session_id="SMART-S1",
            seq=seq, timestamp_ms=item["timestamp_ms"], posture=posture, confidence=0.95,
            pressure_left=500, pressure_right=510, pressure_front=400, pressure_back=600,
            pressure_center=700, total_pressure=2710, left_right_diff=-10, front_back_diff=-200,
            center_x=-0.01, center_y=-0.16, asymmetry_index=0.2, tilt_x=1, tilt_y=2,
            shake_level=0, posture_duration_s=2, sitting_duration_s=seq * 2,
            vibration_enabled=True, warning_active=posture != "normal", reminder_count=seq // 100,
            battery_level=88, recognition_source="mock", model_version="mock-v1", firmware_version="mock-v1",
        ))
    db.commit()
    db.close()

    with TestClient(app) as client:
        login = client.post("/api/v1/auth/login", json={"username": "smart_parent", "password": "parent123"})
        headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
        response = client.post(
            "/api/v1/students/STU-SMART-001/reports/generate",
            headers=headers,
            json={},
        )
        assert response.status_code == 200
        data = response.json()["data"]
        assert data["report_type"] == "smart"
        assert data["generated_by"] == "llm"
        assert data["summary"]["record_count"] == 600
        assert set(data["summary"]["posture_stats"]) == {
            "normal", "left_lean", "right_lean", "front_lean", "back_lean"
        }
        assert data["summary"]["max_continuous_abnormal_s"] > 0
        assert captured["report_mode"] == "latest_records"
        assert captured["fallback_summary"]["record_count"] == 600
        assert len(captured["payload"]["records"]) == 600
        assert captured["payload"]["records"][0]["t"] == base_ms + 50 * 2000

        detail = client.get(
            f"/api/v1/students/STU-SMART-001/reports/{data['report_id']}",
            headers=headers,
        )
        assert detail.status_code == 200
        assert detail.json()["data"]["content"] == "最近600条智能报告"
