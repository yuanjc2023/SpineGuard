from datetime import datetime, time, timezone

from fastapi import WebSocket
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import state
from ..models import Device, DeviceBinding, PostureRecord, utc_now
from ..schemas import Telemetry


async def save_telemetry(data: Telemetry, db: Session) -> None:
    binding = db.scalar(
        select(DeviceBinding)
        .where(DeviceBinding.device_id == data.device_id, DeviceBinding.active.is_(True))
        .order_by(DeviceBinding.id.desc())
        .limit(1)
    )
    student_id = binding.student_id if binding else None

    record = to_posture_record(data, student_id)
    db.add(record)
    update_device_status(data, db)
    db.commit()

    state.latest[data.device_id] = data
    state.history[data.device_id].append(data)
    await broadcast_telemetry(data, student_id)


def get_device_latest(device_id: str, db: Session) -> Telemetry | dict | None:
    current = state.latest.get(device_id)
    if current is not None:
        return current

    stmt = (
        select(PostureRecord)
        .where(PostureRecord.device_id == device_id)
        .order_by(PostureRecord.timestamp_ms.desc(), PostureRecord.id.desc())
        .limit(1)
    )
    record = db.scalars(stmt).first()
    if record is None:
        return None
    return record_to_dict(record)


def get_device_history(
    device_id: str,
    limit: int,
    db: Session,
    from_value: str | None = None,
    to_value: str | None = None,
) -> list[dict]:
    stmt = select(PostureRecord).where(PostureRecord.device_id == device_id)
    stmt = apply_time_range(stmt, from_value, to_value)
    stmt = stmt.order_by(PostureRecord.timestamp_ms.desc(), PostureRecord.id.desc()).limit(limit)
    records = list(db.scalars(stmt))
    records.reverse()
    return [record_to_dict(record) for record in records]


def get_student_latest(student_id: str, db: Session) -> dict | None:
    stmt = (
        select(PostureRecord)
        .where(PostureRecord.student_id == student_id)
        .order_by(PostureRecord.timestamp_ms.desc(), PostureRecord.id.desc())
        .limit(1)
    )
    record = db.scalars(stmt).first()
    if record is None:
        return None
    return record_to_dict(record)


def get_student_history(
    student_id: str,
    limit: int,
    db: Session,
    from_value: str | None = None,
    to_value: str | None = None,
) -> list[dict]:
    stmt = select(PostureRecord).where(PostureRecord.student_id == student_id)
    stmt = apply_time_range(stmt, from_value, to_value)
    stmt = stmt.order_by(PostureRecord.timestamp_ms.desc(), PostureRecord.id.desc()).limit(limit)
    records = list(db.scalars(stmt))
    records.reverse()
    return [record_to_dict(record) for record in records]


def register_subscriber(device_id: str, ws: WebSocket) -> None:
    state.subscribers[device_id].add(ws)


def unregister_subscriber(device_id: str, ws: WebSocket) -> None:
    state.subscribers[device_id].discard(ws)


def register_student_subscriber(student_id: str, ws: WebSocket) -> None:
    state.student_subscribers[student_id].add(ws)


def unregister_student_subscriber(student_id: str, ws: WebSocket) -> None:
    state.student_subscribers[student_id].discard(ws)


async def broadcast_telemetry(data: Telemetry, student_id: str | None = None) -> None:
    dead = []
    for ws in state.subscribers[data.device_id]:
        try:
            await ws.send_json(data.model_dump())
        except Exception:
            dead.append(ws)

    for ws in dead:
        unregister_subscriber(data.device_id, ws)

    if student_id is None:
        return

    student_dead = []
    payload = data.model_dump()
    payload["student_id"] = student_id
    for ws in state.student_subscribers[student_id]:
        try:
            await ws.send_json(payload)
        except Exception:
            student_dead.append(ws)

    for ws in student_dead:
        unregister_student_subscriber(student_id, ws)


def to_posture_record(data: Telemetry, student_id: str | None = None) -> PostureRecord:
    return PostureRecord(
        device_id=data.device_id,
        student_id=student_id,
        session_id=data.session_id,
        seq=data.seq,
        timestamp_ms=data.timestamp_ms,
        posture=data.posture,
        confidence=data.confidence,
        pressure_left=data.pressure.left,
        pressure_right=data.pressure.right,
        pressure_front=data.pressure.front,
        pressure_back=data.pressure.back,
        pressure_center=data.pressure.center,
        total_pressure=data.pressure_features.total_pressure,
        left_right_diff=data.pressure_features.left_right_diff,
        front_back_diff=data.pressure_features.front_back_diff,
        center_x=data.pressure_features.center_x,
        center_y=data.pressure_features.center_y,
        asymmetry_index=data.pressure_features.asymmetry_index,
        tilt_x=data.imu.tilt_x,
        tilt_y=data.imu.tilt_y,
        shake_level=data.imu.shake_level,
        posture_duration_s=data.posture_duration_s,
        sitting_duration_s=data.sitting_duration_s,
        vibration_enabled=data.vibration_enabled,
        warning_active=data.warning_active,
        reminder_count=data.reminder_count,
        battery_level=data.battery_level,
        recognition_source=data.recognition_source,
        model_version=data.model_version,
        firmware_version=data.firmware_version,
    )


def update_device_status(data: Telemetry, db: Session) -> None:
    device = db.scalar(select(Device).where(Device.device_id == data.device_id))
    if device is None:
        return

    device.online_status = "online"
    device.last_seen_at = utc_now()
    device.battery_level = data.battery_level
    device.firmware_version = data.firmware_version
    device.model_version = data.model_version


def apply_time_range(stmt, from_value: str | None, to_value: str | None):
    start_ms = parse_time_filter(from_value, end_of_day=False)
    end_ms = parse_time_filter(to_value, end_of_day=True)
    if start_ms is not None:
        stmt = stmt.where(PostureRecord.timestamp_ms >= start_ms)
    if end_ms is not None:
        stmt = stmt.where(PostureRecord.timestamp_ms <= end_ms)
    return stmt


def parse_time_filter(value: str | None, end_of_day: bool) -> int | None:
    if value is None or value == "":
        return None
    if value.isdigit():
        return int(value)

    try:
        if len(value) == 10:
            date_value = datetime.strptime(value, "%Y-%m-%d").date()
            time_value = time.max if end_of_day else time.min
            dt = datetime.combine(date_value, time_value, tzinfo=timezone.utc)
        else:
            dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
    except ValueError as exc:
        raise ValueError("Time filters must be millisecond timestamp, YYYY-MM-DD, or ISO datetime") from exc

    return int(dt.timestamp() * 1000)


def record_to_dict(record: PostureRecord) -> dict:
    return {
        "protocol_version": 1,
        "device_id": record.device_id,
        "student_id": record.student_id,
        "session_id": record.session_id,
        "seq": record.seq,
        "timestamp_ms": record.timestamp_ms,
        "posture": record.posture,
        "confidence": record.confidence,
        "pressure": {
            "left": record.pressure_left,
            "right": record.pressure_right,
            "front": record.pressure_front,
            "back": record.pressure_back,
            "center": record.pressure_center,
        },
        "pressure_features": {
            "total_pressure": record.total_pressure,
            "left_right_diff": record.left_right_diff,
            "front_back_diff": record.front_back_diff,
            "center_x": record.center_x,
            "center_y": record.center_y,
            "asymmetry_index": record.asymmetry_index,
        },
        "imu": {
            "tilt_x": record.tilt_x,
            "tilt_y": record.tilt_y,
            "shake_level": record.shake_level,
        },
        "posture_duration_s": record.posture_duration_s,
        "sitting_duration_s": record.sitting_duration_s,
        "vibration_enabled": record.vibration_enabled,
        "warning_active": record.warning_active,
        "reminder_count": record.reminder_count,
        "battery_level": record.battery_level,
        "recognition_source": record.recognition_source,
        "model_version": record.model_version,
        "firmware_version": record.firmware_version,
    }
