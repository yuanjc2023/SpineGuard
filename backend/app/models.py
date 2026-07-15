from datetime import date, datetime, timezone

from sqlalchemy import BigInteger, Boolean, Date, DateTime, Float, Integer, String, Text, UniqueConstraint
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


class ScheduledReportRun(Base, TimestampMixin):
    __tablename__ = "scheduled_report_runs"
    __table_args__ = (
        UniqueConstraint(
            "student_id",
            "report_type",
            "period_start",
            "period_end",
            name="uq_scheduled_report_run",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    student_id: Mapped[str] = mapped_column(String(64), index=True)
    report_type: Mapped[str] = mapped_column(String(32), index=True)
    period_start: Mapped[date] = mapped_column(Date, index=True)
    period_end: Mapped[date] = mapped_column(Date, index=True)
    scheduled_for: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    status: Mapped[str] = mapped_column(String(24), default="pending", index=True)
    report_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    notification_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    generated_by: Mapped[str | None] = mapped_column(String(32), nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class ReminderEvent(Base):
    __tablename__ = "reminder_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    device_id: Mapped[str] = mapped_column(String(64), index=True)
    student_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    timestamp_ms: Mapped[int] = mapped_column(BigInteger, index=True)
    posture: Mapped[str] = mapped_column(String(32), index=True)
    reason: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)


class Notification(Base):
    __tablename__ = "notifications"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    notification_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    user_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    student_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    notification_type: Mapped[str] = mapped_column(String(32), default="system", index=True)
    title: Mapped[str] = mapped_column(String(128))
    content: Mapped[str] = mapped_column(Text)
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, index=True)


class TelemetryReceipt(Base):
    __tablename__ = "telemetry_receipts"
    __table_args__ = (
        UniqueConstraint("device_id", "session_id", "seq", name="uq_telemetry_receipt"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    device_id: Mapped[str] = mapped_column(String(64), index=True)
    session_id: Mapped[str] = mapped_column(String(64), index=True)
    seq: Mapped[int] = mapped_column(Integer)
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)


class DeviceSessionState(Base, TimestampMixin):
    __tablename__ = "device_session_states"
    __table_args__ = (
        UniqueConstraint("device_id", "device_session_id", name="uq_device_session_state"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    device_id: Mapped[str] = mapped_column(String(64), index=True)
    student_id: Mapped[str] = mapped_column(String(64), index=True)
    device_session_id: Mapped[str] = mapped_column(String(64), index=True)
    status: Mapped[str] = mapped_column(String(32), default="active", index=True)
    started_at_ms: Mapped[int] = mapped_column(BigInteger)
    last_telemetry_at_ms: Mapped[int] = mapped_column(BigInteger)
    last_received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, index=True)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    current_posture: Mapped[str] = mapped_column(String(32), default="unknown")
    current_posture_since_ms: Mapped[int] = mapped_column(BigInteger)
    last_seq: Mapped[int] = mapped_column(Integer, default=-1)
    session_normal_s: Mapped[int] = mapped_column(Integer, default=0)
    effective_measurement_s: Mapped[int] = mapped_column(Integer, default=0)
    continuous_normal_s: Mapped[int] = mapped_column(Integer, default=0)
    continuous_snapshot_s: Mapped[int] = mapped_column(Integer, default=0)
    reminder_count: Mapped[int] = mapped_column(Integer, default=0)
    abnormal_episode_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    normal_recovery_since_ms: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    normal_recovery_s: Mapped[int] = mapped_column(Integer, default=0)
    empty_since_ms: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    empty_duration_s: Mapped[int] = mapped_column(Integer, default=0)
    unknown_since_ms: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    unknown_duration_s: Mapped[int] = mapped_column(Integer, default=0)
    unknown_notified: Mapped[bool] = mapped_column(Boolean, default=False)
    severe_recovery_pending: Mapped[bool] = mapped_column(Boolean, default=False)


class AbnormalEpisode(Base):
    __tablename__ = "abnormal_episodes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    episode_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    device_session_state_id: Mapped[int] = mapped_column(Integer, index=True)
    student_id: Mapped[str] = mapped_column(String(64), index=True)
    started_at_ms: Mapped[int] = mapped_column(BigInteger, index=True)
    ended_at_ms: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    duration_s: Mapped[int] = mapped_column(Integer, default=0)
    first_posture: Mapped[str] = mapped_column(String(32))
    last_posture: Mapped[str] = mapped_column(String(32))
    continuous_snapshot_s: Mapped[int] = mapped_column(Integer, default=0)
    reminded: Mapped[bool] = mapped_column(Boolean, default=False)
    continuous_reset: Mapped[bool] = mapped_column(Boolean, default=False)
    status: Mapped[str] = mapped_column(String(32), default="active", index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)


class GardenAccount(Base, TimestampMixin):
    __tablename__ = "garden_accounts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    student_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    growth: Mapped[int] = mapped_column(Integer, default=0)
    sunshine: Mapped[int] = mapped_column(Integer, default=0)
    water: Mapped[int] = mapped_column(Integer, default=0)
    nutrient: Mapped[int] = mapped_column(Integer, default=0)
    recovery_needed: Mapped[bool] = mapped_column(Boolean, default=False)
    version: Mapped[int] = mapped_column(Integer, default=1)


class GameDailyProgress(Base, TimestampMixin):
    __tablename__ = "game_daily_progress"
    __table_args__ = (
        UniqueConstraint("student_id", "local_date", name="uq_game_daily_progress"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    student_id: Mapped[str] = mapped_column(String(64), index=True)
    local_date: Mapped[date] = mapped_column(Date, index=True)
    normal_s: Mapped[int] = mapped_column(Integer, default=0)
    effective_measurement_s: Mapped[int] = mapped_column(Integer, default=0)
    reminder_count: Mapped[int] = mapped_column(Integer, default=0)
    settled_normal_s: Mapped[int] = mapped_column(Integer, default=0)
    settled_effective_s: Mapped[int] = mapped_column(Integer, default=0)
    settled_reminder_count: Mapped[int] = mapped_column(Integer, default=0)
    growth_granted: Mapped[int] = mapped_column(Integer, default=0)
    last_settlement_date: Mapped[date | None] = mapped_column(Date, nullable=True)


class GrowthSettlementSegment(Base):
    __tablename__ = "growth_settlement_segments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    settlement_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    student_id: Mapped[str] = mapped_column(String(64), index=True)
    local_date: Mapped[date] = mapped_column(Date, index=True)
    business_key: Mapped[str] = mapped_column(String(160), unique=True, index=True)
    normal_s: Mapped[int] = mapped_column(Integer)
    effective_measurement_s: Mapped[int] = mapped_column(Integer)
    reminder_count: Mapped[int] = mapped_column(Integer)
    calculated_growth: Mapped[int] = mapped_column(Integer)
    reminder_rate_30m: Mapped[float] = mapped_column(Float)
    performance_factor: Mapped[float] = mapped_column(Float)
    growth_before_cap: Mapped[int] = mapped_column(Integer)
    granted_growth: Mapped[int] = mapped_column(Integer)
    rule_version: Mapped[str] = mapped_column(String(32))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)


class RewardLedger(Base):
    __tablename__ = "reward_ledger"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    ledger_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    student_id: Mapped[str] = mapped_column(String(64), index=True)
    business_key: Mapped[str] = mapped_column(String(180), unique=True, index=True)
    source_type: Mapped[str] = mapped_column(String(32), index=True)
    source_id: Mapped[str] = mapped_column(String(128))
    growth_delta: Mapped[int] = mapped_column(Integer, default=0)
    sunshine_delta: Mapped[int] = mapped_column(Integer, default=0)
    water_delta: Mapped[int] = mapped_column(Integer, default=0)
    nutrient_delta: Mapped[int] = mapped_column(Integer, default=0)
    balance_after_json: Mapped[str] = mapped_column(Text, default="{}")
    rule_version: Mapped[str] = mapped_column(String(32))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, index=True)


class MilestoneClaim(Base):
    __tablename__ = "milestone_claims"
    __table_args__ = (
        UniqueConstraint(
            "device_session_state_id",
            "reward_type",
            "milestone_minute",
            name="uq_milestone_claim",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    device_session_state_id: Mapped[int] = mapped_column(Integer, index=True)
    student_id: Mapped[str] = mapped_column(String(64), index=True)
    reward_type: Mapped[str] = mapped_column(String(32), default="continuous")
    milestone_minute: Mapped[int] = mapped_column(Integer)
    ledger_id: Mapped[str] = mapped_column(String(64))
    claimed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)


class DailyTaskState(Base, TimestampMixin):
    __tablename__ = "daily_task_states"
    __table_args__ = (
        UniqueConstraint("student_id", "local_date", "task_code", name="uq_daily_task_state"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    student_id: Mapped[str] = mapped_column(String(64), index=True)
    local_date: Mapped[date] = mapped_column(Date, index=True)
    task_code: Mapped[str] = mapped_column(String(64), index=True)
    status: Mapped[str] = mapped_column(String(16), default="locked", index=True)
    progress_value: Mapped[int] = mapped_column(Integer, default=0)
    target_value: Mapped[int] = mapped_column(Integer, default=0)
    ledger_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    claimed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class IdempotencyRecord(Base):
    __tablename__ = "idempotency_records"
    __table_args__ = (
        UniqueConstraint("user_id", "scope", "idempotency_key", name="uq_idempotency_record"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    user_id: Mapped[str] = mapped_column(String(64), index=True)
    scope: Mapped[str] = mapped_column(String(128), index=True)
    idempotency_key: Mapped[str] = mapped_column(String(128))
    response_json: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
