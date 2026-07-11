from datetime import date, datetime, timezone

from sqlalchemy import BigInteger, Boolean, Date, DateTime, Float, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=utc_now,
        onupdate=utc_now,
    )


class User(Base, TimestampMixin):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    user_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[str] = mapped_column(String(32), index=True)


class Student(Base, TimestampMixin):
    __tablename__ = "students"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    student_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    display_code: Mapped[str] = mapped_column(String(64), index=True)
    school_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    class_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)


class UserStudentLink(Base):
    __tablename__ = "user_student_links"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    user_id: Mapped[str] = mapped_column(String(64), index=True)
    student_id: Mapped[str] = mapped_column(String(64), index=True)
    relation: Mapped[str] = mapped_column(String(32), default="guardian")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)


class Device(Base, TimestampMixin):
    __tablename__ = "devices"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    device_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    device_token_hash: Mapped[str] = mapped_column(String(255))
    firmware_version: Mapped[str] = mapped_column(String(64), default="")
    model_version: Mapped[str] = mapped_column(String(64), default="")
    battery_level: Mapped[int | None] = mapped_column(Integer, nullable=True)
    online_status: Mapped[str] = mapped_column(String(32), default="unknown", index=True)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class DeviceBinding(Base):
    __tablename__ = "device_bindings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    device_id: Mapped[str] = mapped_column(String(64), index=True)
    student_id: Mapped[str] = mapped_column(String(64), index=True)
    bound_by_user_id: Mapped[str] = mapped_column(String(64), index=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    bound_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    unbound_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class PostureRecord(Base):
    __tablename__ = "posture_records"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    device_id: Mapped[str] = mapped_column(String(64), index=True)
    student_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    session_id: Mapped[str] = mapped_column(String(64), index=True)
    seq: Mapped[int] = mapped_column(Integer)
    timestamp_ms: Mapped[int] = mapped_column(BigInteger, index=True)
    posture: Mapped[str] = mapped_column(String(32), index=True)
    confidence: Mapped[float] = mapped_column(Float)

    pressure_left: Mapped[int] = mapped_column(Integer)
    pressure_right: Mapped[int] = mapped_column(Integer)
    pressure_front: Mapped[int] = mapped_column(Integer)
    pressure_back: Mapped[int] = mapped_column(Integer)
    pressure_center: Mapped[int] = mapped_column(Integer)

    total_pressure: Mapped[int] = mapped_column(Integer)
    left_right_diff: Mapped[int] = mapped_column(Integer)
    front_back_diff: Mapped[int] = mapped_column(Integer)
    center_x: Mapped[float] = mapped_column(Float)
    center_y: Mapped[float] = mapped_column(Float)
    asymmetry_index: Mapped[float] = mapped_column(Float)

    tilt_x: Mapped[float] = mapped_column(Float)
    tilt_y: Mapped[float] = mapped_column(Float)
    shake_level: Mapped[float] = mapped_column(Float)

    posture_duration_s: Mapped[int] = mapped_column(Integer)
    sitting_duration_s: Mapped[int] = mapped_column(Integer)
    vibration_enabled: Mapped[bool] = mapped_column(Boolean)
    warning_active: Mapped[bool] = mapped_column(Boolean)
    reminder_count: Mapped[int] = mapped_column(Integer)
    battery_level: Mapped[int] = mapped_column(Integer)

    recognition_source: Mapped[str] = mapped_column(String(32))
    model_version: Mapped[str] = mapped_column(String(64))
    firmware_version: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)


class DailyStat(Base, TimestampMixin):
    __tablename__ = "daily_stats"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    student_id: Mapped[str] = mapped_column(String(64), index=True)
    stat_date: Mapped[date] = mapped_column(Date, index=True)
    total_sitting_s: Mapped[int] = mapped_column(Integer, default=0)
    normal_sitting_s: Mapped[int] = mapped_column(Integer, default=0)
    poor_sitting_s: Mapped[int] = mapped_column(Integer, default=0)
    normal_ratio: Mapped[float] = mapped_column(Float, default=0.0)
    left_lean_count: Mapped[int] = mapped_column(Integer, default=0)
    right_lean_count: Mapped[int] = mapped_column(Integer, default=0)
    front_lean_count: Mapped[int] = mapped_column(Integer, default=0)
    back_lean_count: Mapped[int] = mapped_column(Integer, default=0)
    reminder_count: Mapped[int] = mapped_column(Integer, default=0)
    avg_asymmetry_index: Mapped[float] = mapped_column(Float, default=0.0)
    max_poor_posture_duration_s: Mapped[int] = mapped_column(Integer, default=0)


class RiskAssessment(Base):
    __tablename__ = "risk_assessments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    student_id: Mapped[str] = mapped_column(String(64), index=True)
    period_start: Mapped[date] = mapped_column(Date, index=True)
    period_end: Mapped[date] = mapped_column(Date, index=True)
    risk_level: Mapped[str] = mapped_column(String(16), index=True)
    risk_score: Mapped[int] = mapped_column(Integer)
    risk_reasons: Mapped[str] = mapped_column(Text, default="[]")
    suggestion: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)


class Report(Base):
    __tablename__ = "reports"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    student_id: Mapped[str] = mapped_column(String(64), index=True)
    report_type: Mapped[str] = mapped_column(String(32), index=True)
    period_start: Mapped[date] = mapped_column(Date, index=True)
    period_end: Mapped[date] = mapped_column(Date, index=True)
    summary_json: Mapped[str] = mapped_column(Text, default="{}")
    content: Mapped[str] = mapped_column(Text)
    generated_by: Mapped[str] = mapped_column(String(32), default="rule")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)


class ReminderEvent(Base):
    __tablename__ = "reminder_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    device_id: Mapped[str] = mapped_column(String(64), index=True)
    student_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    timestamp_ms: Mapped[int] = mapped_column(BigInteger, index=True)
    posture: Mapped[str] = mapped_column(String(32), index=True)
    reason: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
