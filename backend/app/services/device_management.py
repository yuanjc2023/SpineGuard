import json

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import DEVICE_TOKEN
from ..models import Device, DeviceBinding, DeviceCommand, User, UserStudentLink
from .auth import verify_secret


def authenticate_device(
    device_id: str,
    device_token: str,
    db: Session,
    *,
    allow_global_token: bool = True,
) -> Device | None:
    if not device_id or not device_token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing device credentials")
    device = db.scalar(select(Device).where(Device.device_id == device_id))
    if device is not None and verify_secret(device_token, device.device_token_hash):
        return device
    if (
        allow_global_token
        and device_token == DEVICE_TOKEN
        and (device is None or device.claim_code_hash is None)
    ):
        return device
    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid device credentials")


def ensure_device_access(device_id: str, user: User, db: Session) -> Device:
    device = db.scalar(select(Device).where(Device.device_id == device_id))
    if device is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Device not found")
    if user.role in {"school_admin", "doctor", "admin"}:
        return device
    allowed = db.scalar(
        select(DeviceBinding.id)
        .join(UserStudentLink, UserStudentLink.student_id == DeviceBinding.student_id)
        .where(
            DeviceBinding.device_id == device_id,
            DeviceBinding.active.is_(True),
            UserStudentLink.user_id == user.user_id,
        )
        .limit(1)
    )
    if allowed is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")
    return device


def device_config_payload(device: Device, db: Session) -> dict:
    command = db.scalar(
        select(DeviceCommand)
        .where(
            DeviceCommand.device_id == device.device_id,
            DeviceCommand.status.in_(["pending", "queued", "running"]),
        )
        .order_by(DeviceCommand.id.asc())
        .limit(1)
    )
    return {
        "config_version": device.config_version,
        "device_name": device.device_name,
        "reminder": {
            "enabled": device.vibration_enabled,
            "mode": device.reminder_mode,
            "trigger_duration_s": device.reminder_trigger_duration_s,
            "vibration_duration_s": device.reminder_vibration_duration_s,
            "cooldown_s": device.reminder_cooldown_s,
            "intensity_percent": device.reminder_intensity_percent,
        },
        "command": command_payload(command) if command else None,
    }


def command_payload(command: DeviceCommand) -> dict:
    return {
        "id": command.command_id,
        "type": command.command_type,
        "firmware_url": command.firmware_url,
        "firmware_sha256": command.firmware_sha256,
        "target_version": command.target_version,
        "status": command.status,
        "progress_percent": command.progress_percent,
        "error": command.error_message,
    }


def sensor_status(device: Device) -> dict | None:
    if not device.sensor_status_json:
        return None
    try:
        return json.loads(device.sensor_status_json)
    except json.JSONDecodeError:
        return None
