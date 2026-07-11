from fastapi import WebSocket
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import state
from ..models import PostureRecord
from ..schemas import Telemetry


async def save_telemetry(data: Telemetry, db: Session) -> None:
    db.add(to_posture_record(data))
    db.commit()

    state.latest[data.device_id] = data
    state.history[data.device_id].append(data)
    await broadcast_telemetry(data)


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


def get_device_history(device_id: str, limit: int, db: Session) -> list[dict]:
    stmt = (
        select(PostureRecord)
        .where(PostureRecord.device_id == device_id)
        .order_by(PostureRecord.timestamp_ms.desc(), PostureRecord.id.desc())
        .limit(limit)
    )
    records = list(db.scalars(stmt))
    records.reverse()
    return [record_to_dict(record) for record in records]


def register_subscriber(device_id: str, ws: WebSocket) -> None:
    state.subscribers[device_id].add(ws)


def unregister_subscriber(device_id: str, ws: WebSocket) -> None:
    state.subscribers[device_id].discard(ws)


async def broadcast_telemetry(data: Telemetry) -> None:
    dead = []
    for ws in state.subscribers[data.device_id]:
        try:
            await ws.send_json(data.model_dump())
        except Exception:
            dead.append(ws)

    for ws in dead:
        unregister_subscriber(data.device_id, ws)


def to_posture_record(data: Telemetry) -> PostureRecord:
    return PostureRecord(
        device_id=data.device_id,
        student_id=None,
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
