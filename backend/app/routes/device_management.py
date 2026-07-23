from fastapi import APIRouter, Depends, Header, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import API_PREFIX
from ..db import get_db
from ..models import Device, DeviceCommand, User
from ..schemas import DeviceCommandCreate, DeviceRegistrationRequest, ReminderConfigUpdate
from ..services.auth import get_current_user, hash_secret, new_public_id, require_roles
from ..services.device_management import (
    authenticate_device,
    command_payload,
    complete_pending_pairing,
    device_config_payload,
    ensure_device_access,
)

router = APIRouter(prefix=API_PREFIX, tags=["device-management"])


@router.post("/device/register")
def register_device(
    data: DeviceRegistrationRequest,
    x_device_id: str = Header(default=""),
    x_device_token: str = Header(default=""),
    db: Session = Depends(get_db),
):
    if x_device_id != data.device_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Device ID mismatch")
    if len(x_device_token) != 64:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid device secret")

    device = db.scalar(select(Device).where(Device.device_id == data.device_id))
    created = device is None
    if created:
        device = Device(
            device_id=data.device_id,
            device_token_hash=hash_secret(x_device_token),
            device_name=data.device_name,
            claim_code_hash=hash_secret(data.claim_code),
            firmware_version=data.firmware_version,
            model_version=data.model_version,
            online_status="registered",
        )
        db.add(device)
    else:
        if device.claim_code_hash is not None:
            authenticate_device(data.device_id, x_device_token, db, allow_global_token=False)
        device.device_token_hash = hash_secret(x_device_token)
        device.device_name = data.device_name
        device.claim_code_hash = hash_secret(data.claim_code)
        device.firmware_version = data.firmware_version
        device.model_version = data.model_version
        device.online_status = "registered"

    pairing = complete_pending_pairing(data.device_id, data.claim_code, db)
    db.commit()
    return {
        "ok": True,
        "device_id": data.device_id,
        "created": created,
        "pairing_status": "completed" if pairing is not None else None,
        "pairing_id": pairing.pairing_id if pairing is not None else None,
    }


@router.get("/device/config/{device_id}")
def poll_device_config(
    device_id: str,
    x_device_id: str = Header(default=""),
    x_device_token: str = Header(default=""),
    db: Session = Depends(get_db),
):
    if x_device_id != device_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Device ID mismatch")
    device = authenticate_device(device_id, x_device_token, db, allow_global_token=False)
    if device is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Device not registered")
    return {"ok": True, "data": device_config_payload(device, db)}


@router.get("/devices/{device_id}/config")
def get_device_config(
    device_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    device = ensure_device_access(device_id, current_user, db)
    return {"ok": True, "data": device_config_payload(device, db)}


@router.put("/devices/{device_id}/config")
def update_device_config(
    device_id: str,
    data: ReminderConfigUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    device = ensure_device_access(device_id, current_user, db)
    changes = data.model_dump(exclude_none=True)
    if not changes:
        return {"ok": True, "data": device_config_payload(device, db)}

    field_map = {
        "device_name": "device_name",
        "enabled": "vibration_enabled",
        "mode": "reminder_mode",
        "trigger_duration_s": "reminder_trigger_duration_s",
        "vibration_duration_s": "reminder_vibration_duration_s",
        "cooldown_s": "reminder_cooldown_s",
        "intensity_percent": "reminder_intensity_percent",
    }
    for name, value in changes.items():
        setattr(device, field_map[name], value)
    device.config_version += 1
    db.commit()
    db.refresh(device)
    return {"ok": True, "data": device_config_payload(device, db)}


@router.post("/devices/{device_id}/commands")
def create_device_command(
    device_id: str,
    data: DeviceCommandCreate,
    current_user: User = Depends(require_roles("school_admin", "admin")),
    db: Session = Depends(get_db),
):
    ensure_device_access(device_id, current_user, db)
    if data.type == "ota_update" and not all(
        [data.firmware_url, data.firmware_sha256, data.target_version]
    ):
        raise HTTPException(status_code=422, detail="OTA command requires URL, SHA-256 and target version")
    if data.type != "ota_update" and any(
        [data.firmware_url, data.firmware_sha256, data.target_version]
    ):
        raise HTTPException(status_code=422, detail="Firmware fields are only valid for OTA commands")

    active = db.scalar(
        select(DeviceCommand).where(
            DeviceCommand.device_id == device_id,
            DeviceCommand.status.in_(["pending", "queued", "running"]),
        )
    )
    if active is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Device already has an active command")

    command = DeviceCommand(
        command_id=new_public_id("CMD"),
        device_id=device_id,
        command_type=data.type,
        firmware_url=data.firmware_url,
        firmware_sha256=data.firmware_sha256.lower() if data.firmware_sha256 else None,
        target_version=data.target_version,
        created_by_user_id=current_user.user_id,
    )
    db.add(command)
    db.commit()
    db.refresh(command)
    return {"ok": True, "data": command_payload(command)}


@router.get("/devices/{device_id}/commands")
def list_device_commands(
    device_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ensure_device_access(device_id, current_user, db)
    commands = list(
        db.scalars(
            select(DeviceCommand)
            .where(DeviceCommand.device_id == device_id)
            .order_by(DeviceCommand.id.desc())
            .limit(50)
        )
    )
    return {"ok": True, "items": [command_payload(item) for item in commands]}
