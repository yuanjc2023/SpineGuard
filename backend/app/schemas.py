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


class PressureFeatures(BaseModel):
    total_pressure: int = Field(ge=0, le=5000)
    left_right_diff: int = Field(ge=-1000, le=1000)
    front_back_diff: int = Field(ge=-1000, le=1000)
    center_x: float = Field(ge=-1, le=1)
    center_y: float = Field(ge=-1, le=1)
    asymmetry_index: float = Field(ge=0, le=1)


class Imu(BaseModel):
    tilt_x: float = Field(ge=-180, le=180)
    tilt_y: float = Field(ge=-180, le=180)
    shake_level: float = Field(ge=0, le=1)


class Telemetry(BaseModel):
    protocol_version: Literal[1] = 1
    device_id: str
    session_id: str
    seq: int = Field(ge=0)
    timestamp_ms: int = Field(ge=0)
    posture: Posture
    confidence: float = Field(ge=0, le=1)
    pressure: Pressure
    pressure_features: PressureFeatures
    imu: Imu
    posture_duration_s: int = Field(ge=0)
    sitting_duration_s: int = Field(ge=0)
    vibration_enabled: bool
    warning_active: bool
    reminder_count: int = Field(ge=0)
    battery_level: int = Field(ge=0, le=100)
    recognition_source: Literal["rule", "neural_network", "mock"]
    model_version: str
    firmware_version: str


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
    firmware_version: str
    model_version: str
    battery_level: int | None
    online_status: str
    last_seen_at: str | None


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
    report_type: Literal["daily", "weekly", "monthly"] = "daily"
    use_llm: bool = False
    date: str | None = None


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
    created_at: str
    read_at: str | None
