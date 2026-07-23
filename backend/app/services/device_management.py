import json
from datetime import datetime, timezone

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import DEVICE_TOKEN
from ..models import (
    Device,
    DeviceBinding,
    DeviceCommand,
    DevicePairingRequest,
    Student,
    User,
    UserStudentLink,
    utc_now,
)
from .auth import new_public_id, verify_secret


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


def ensure_student_binding_access(student_id: str, user: User, db: Session) -> Student:
    student = db.scalar(select(Student).where(Student.student_id == student_id))
    if student is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Student not found")
    if user.role == "parent":
        link = db.scalar(
            select(UserStudentLink.id).where(
                UserStudentLink.user_id == user.user_id,
                UserStudentLink.student_id == student_id,
            )
        )
        if link is None:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")
    return student


def activate_device_binding(
    device_id: str,
    student_id: str,
    user_id: str,
    db: Session,
) -> DeviceBinding:
    existing = db.scalar(
        select(DeviceBinding).where(
            DeviceBinding.device_id == device_id,
            DeviceBinding.student_id == student_id,
            DeviceBinding.active.is_(True),
        )
    )
    now = utc_now()
    old_bindings = list(
        db.scalars(
            select(DeviceBinding).where(
                (
                    (DeviceBinding.device_id == device_id)
                    | (DeviceBinding.student_id == student_id)
                ),
                DeviceBinding.active.is_(True),
            )
        )
    )
    for old in old_bindings:
        if existing is not None and old.id == existing.id:
            continue
        old.active = False
        old.unbound_at = now

    if existing is not None:
        return existing

    binding = DeviceBinding(
        device_id=device_id,
        student_id=student_id,
        bound_by_user_id=user_id,
        active=True,
    )
    db.add(binding)
    db.flush()
    return binding


def queue_claim_code_rotation(device_id: str, user_id: str, db: Session) -> None:
    queued = db.scalar(
        select(DeviceCommand.id).where(
            DeviceCommand.device_id == device_id,
            DeviceCommand.command_type == "rotate_claim_code",
            DeviceCommand.status.in_(["pending", "queued", "running"]),
        )
    )
    if queued is not None:
        return
    db.add(
        DeviceCommand(
            command_id=new_public_id("CMD"),
            device_id=device_id,
            command_type="rotate_claim_code",
            created_by_user_id=user_id,
        )
    )


def complete_pending_pairing(
    device_id: str,
    claim_code: str,
    db: Session,
) -> DevicePairingRequest | None:
    now = utc_now()
    requests = list(
        db.scalars(
            select(DevicePairingRequest)
            .where(
                DevicePairingRequest.device_id == device_id,
                DevicePairingRequest.status == "pending",
            )
            .order_by(DevicePairingRequest.id.desc())
        )
    )
    for pairing in requests:
        if _as_utc(pairing.expires_at) <= now:
            pairing.status = "expired"
            pairing.error_message = "Pairing request expired"
            continue
        if not verify_secret(claim_code, pairing.claim_code_hash):
            continue
        binding = activate_device_binding(
            device_id=device_id,
            student_id=pairing.student_id,
            user_id=pairing.requested_by_user_id,
            db=db,
        )
        pairing.status = "completed"
        pairing.completed_at = now
        pairing.binding_id = binding.id
        pairing.error_message = None
        queue_claim_code_rotation(device_id, pairing.requested_by_user_id, db)
        return pairing
    return None


def expire_pairing_request(pairing: DevicePairingRequest) -> None:
    if pairing.status == "pending" and _as_utc(pairing.expires_at) <= utc_now():
        pairing.status = "expired"
        pairing.error_message = "Pairing request expired"


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


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
