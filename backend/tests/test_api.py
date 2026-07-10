from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)

def test_round_trip():
    payload = {
        "protocol_version":1,"device_id":"SG-0001","session_id":"T1","seq":1,
        "timestamp_ms":1,"posture":"normal","confidence":0.95,
        "pressure":{"left":500,"right":510,"front":400,"back":600,"center":700},
        "posture_duration_s":5,"sitting_duration_s":30,
        "vibration_enabled":True,"warning_active":False,
        "recognition_source":"mock","model_version":"mock-v0.1","firmware_version":"0.1.0"
    }
    r = client.post("/api/v1/device/telemetry", headers={"X-Device-Token":"dev-token"}, json=payload)
    assert r.status_code == 200
    r = client.get("/api/v1/devices/SG-0001/latest")
    assert r.json()["data"]["posture"] == "normal"
