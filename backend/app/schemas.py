from typing import Literal

from pydantic import BaseModel, Field

Posture = Literal[
    "empty",
    "normal",
    "left_lean",
    "right_lean",
    "front_lean",
    "back_lean",
    "unknown",
]


class Pressure(BaseModel):
    left: int = Field(ge=0, le=1000)
    right: int = Field(ge=0, le=1000)
    front: int = Field(ge=0, le=1000)
    back: int = Field(ge=0, le=1000)
    center: int = Field(ge=0, le=1000)


class RawPressure(BaseModel):
    left: int = Field(ge=0, le=4095)
    right: int = Field(ge=0, le=4095)
    front: int = Field(ge=0, le=4095)
    back: int = Field(ge=0, le=4095)
    center: int = Field(ge=0, le=4095)


class PressureFeatures(BaseModel):
    total_pressure: int = Field(ge=0, le=7500)
    left_right_diff: int = Field(ge=-1000, le=1000)
    front_back_diff: int = Field(ge=-1000, le=1000)
    center_x: float = Field(ge=-1, le=1)
    center_y: float = Field(ge=-1, le=1)
    asymmetry_index: float = Field(ge=0, le=1)


class Imu(BaseModel):
    tilt_x: float = Field(ge=-180, le=180)
    tilt_y: float = Field(ge=-180, le=180)
    shake_level: float = Field(ge=0, le=1)


class Backrest(BaseModel):
    online: bool
    data_ready: bool
    valid: bool
    distance_mm: float | None = Field(default=None, ge=0, le=4000)
    range_status: int = Field(ge=0, le=255)


class ReminderConfig(BaseModel):
    mode: Literal["normal", "study", "do_not_disturb"]
    trigger_duration_s: int = Field(ge=5, le=3600)
    vibration_duration_s: int = Field(ge=1, le=120)
    cooldown_s: int = Field(ge=30, le=7200)
    intensity_percent: int = Field(ge=0, le=100)


FsrHealth = Literal[
    "unknown", "ok", "baseline_invalid", "baseline_drift", "stuck_low",
    "stuck_high", "no_change", "out_of_calibration",
]


class FsrSensorStatus(BaseModel):
    left: FsrHealth
    right: FsrHealth
    front: FsrHealth
    back: FsrHealth
    center: FsrHealth
    all_ok: bool
    baseline_valid: bool


class TofSensorStatus(BaseModel):
    online: bool
    valid: bool


class MotorSensorStatus(BaseModel):
    control_ready: bool
    self_test_completed: bool
    power_verified: bool


class SensorStatus(BaseModel):
    fsr: FsrSensorStatus
    tof: TofSensorStatus
    motor: MotorSensorStatus


class CommandStatus(BaseModel):
    id: str | None = Field(default=None, max_length=64)
    type: Literal[
        "none", "calibrate_empty", "restart", "enter_provisioning",
        "factory_reset", "rotate_claim_code", "ota_update",
    ]
    status: Literal["idle", "queued", "running", "success", "failed"]
    progress_percent: int = Field(ge=0, le=100)
    error: str | None = Field(default=None, max_length=256)


class Telemetry(BaseModel):
    protocol_version: Literal[2] = 2
    device_id: str
    session_id: str
    seq: int = Field(ge=0)
    timestamp_ms: int = Field(ge=0)
    device_name: str | None = Field(default=None, max_length=64)
    occupied: bool | None = None
    ratio_valid: bool | None = None
    posture: Posture
    confidence: float = Field(ge=0, le=1)
    pressure: Pressure
    raw_pressure: RawPressure
    pressure_features: PressureFeatures
    imu: Imu | None = None
    backrest: Backrest | None = None
    posture_duration_s: int = Field(ge=0)
    sitting_duration_s: int = Field(ge=0)
    applied_config_version: int | None = Field(default=None, ge=0)
    vibration_enabled: bool
    vibration_effective_enabled: bool | None = None
    warning_active: bool
    reminder_due: bool | None = None
    reminder_suppressed: bool | None = None
    vibration_active: bool | None = None
    vibration_position: Literal["left", "front", "right", "back"] | None = None
    reminder_count: int = Field(ge=0)
    reminder_cooldown_remaining_s: int | None = Field(default=None, ge=0)
    reminder_config: ReminderConfig | None = None
    battery_level: int | None = Field(default=None, ge=0, le=100)
    power_source: str | None = Field(default=None, max_length=32)
    wifi_rssi_dbm: int | None = Field(default=None, ge=-127, le=0)
    sensor_status: SensorStatus | None = None
    command_status: CommandStatus | None = None
    device_credential_mode: Literal["global_token", "per_device_secret"] | None = None
    recognition_source: Literal["rule", "lightgbm", "neural_network", "mock"]
    model_version: str
    firmware_version: str


class DeviceRegistrationRequest(BaseModel):
    device_id: str = Field(min_length=1, max_length=64)
    device_name: str = Field(min_length=1, max_length=64)
    claim_code: str = Field(min_length=6, max_length=6, pattern=r"^\d{6}$")
    firmware_version: str = Field(default="", max_length=64)
    model_version: str = Field(default="", max_length=64)


class ReminderConfigUpdate(BaseModel):
    device_name: str | None = Field(default=None, min_length=1, max_length=64)
    enabled: bool | None = None
    mode: Literal["normal", "study", "do_not_disturb"] | None = None
    trigger_duration_s: int | None = Field(default=None, ge=5, le=3600)
    vibration_duration_s: int | None = Field(default=None, ge=1, le=120)
    cooldown_s: int | None = Field(default=None, ge=30, le=7200)
    intensity_percent: int | None = Field(default=None, ge=1, le=100)


class DeviceCommandCreate(BaseModel):
    type: Literal[
        "calibrate_empty", "restart", "enter_provisioning", "factory_reset",
        "rotate_claim_code", "ota_update",
    ]
    firmware_url: str | None = Field(default=None, max_length=320)
    firmware_sha256: str | None = Field(default=None, max_length=64, pattern=r"^[0-9a-fA-F]{64}$")
    target_version: str | None = Field(default=None, max_length=48)


class RegisterRequest(BaseModel):
    username: str = Field(min_length=3, max_length=64)
    password: str = Field(min_length=6, max_length=128)
    role: Literal["parent", "school_admin", "doctor", "admin"] = "parent"


class LoginRequest(BaseModel):
    username: str
    password: str


class UserOut(BaseModel):
    user_id: str
    username: str
    role: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut


class StudentCreate(BaseModel):
    display_code: str = Field(min_length=1, max_length=64)
    school_id: str | None = Field(default=None, max_length=64)
    class_id: str | None = Field(default=None, max_length=64)


class StudentOut(BaseModel):
    student_id: str
    display_code: str
    school_id: str | None
    class_id: str | None


class DeviceCreate(BaseModel):
    device_id: str = Field(min_length=1, max_length=64)
    device_token: str = Field(min_length=3, max_length=128)
    firmware_version: str = Field(default="", max_length=64)
    model_version: str = Field(default="", max_length=64)


class DeviceOut(BaseModel):
    device_id: str
    device_name: str = "SpineGuard"
    firmware_version: str
    model_version: str
    battery_level: int | None
    online_status: str
    last_seen_at: str | None
    config_version: int = 0
    applied_config_version: int | None = None
    power_source: str | None = None
    wifi_rssi_dbm: int | None = None
    sensor_status: dict | None = None


class DeviceBindRequest(BaseModel):
    device_id: str
    student_id: str
    bind_code: str | None = Field(default=None, max_length=32)


class DeviceBindingOut(BaseModel):
    device_id: str
    student_id: str
    bound_by_user_id: str
    active: bool


class DailyStatOut(BaseModel):
    student_id: str
    stat_date: str
    total_sitting_s: int
    normal_sitting_s: int
    poor_sitting_s: int
    normal_ratio: float
    left_lean_count: int
    right_lean_count: int
    front_lean_count: int
    back_lean_count: int
    reminder_count: int
    avg_asymmetry_index: float
    max_poor_posture_duration_s: int


class RiskAssessmentOut(BaseModel):
    student_id: str
    period_start: str
    period_end: str
    risk_level: Literal["green", "yellow", "red"]
    risk_score: int
    risk_reasons: list[str]
    suggestion: str


class ReportGenerateRequest(BaseModel):
    report_type: Literal["smart", "daily", "weekly", "monthly"] = "smart"
    use_llm: bool = True
    date: str | None = None
    record_limit: int = Field(default=600, ge=1, le=1000)


class ReportOut(BaseModel):
    student_id: str
    report_type: str
    period_start: str
    period_end: str
    summary: dict
    content: str
    generated_by: str
    created_at: str


class NotificationCreate(BaseModel):
    title: str = Field(min_length=1, max_length=128)
    content: str = Field(min_length=1, max_length=2000)
    notification_type: Literal["system", "risk", "reminder", "report"] = "system"
    user_id: str | None = Field(default=None, max_length=64)
    student_id: str | None = Field(default=None, max_length=64)


class NotificationOut(BaseModel):
    notification_id: str
    user_id: str | None
    student_id: str | None
    notification_type: str
    title: str
    content: str
    is_read: bool
    related_report_id: int | None = None
    created_at: str
    read_at: str | None


class IdempotentRequest(BaseModel):
    idempotency_key: str = Field(min_length=8, max_length=128)


class GardenActionRequest(IdempotentRequest):
    action: Literal["sunbathe", "water", "fertilize", "recover_tree"]
    quantity: int = Field(default=1, ge=1, le=5)
