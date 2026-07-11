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

