from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import API_PREFIX
from ..db import get_db
from ..models import Device, DeviceBinding, DevicePairingRequest, User, UserStudentLink, utc_now
from ..schemas import (
    DeviceBindRequest,
    DeviceBindingOut,
    DeviceCreate,
    DeviceOut,
    DevicePairingOut,
    DevicePairRequest,
)
from ..services.auth import get_current_user, hash_secret, new_public_id, require_roles, verify_secret
from ..services.device_management import (
    activate_device_binding,
    ensure_student_binding_access,
    expire_pairing_request,
    queue_claim_code_rotation,
    sensor_status,
)

router = APIRouter(prefix=f"{API_PREFIX}/devices", tags=["devices"])
PAIRING_TTL_MINUTES = 10


@router.get("")
def list_devices(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if current_user.role in ("school_admin", "doctor", "admin"):
        devices = list(db.scalars(select(Device).order_by(Device.device_id)))
    else:
        stmt = (
            select(Device)
            .join(DeviceBinding, DeviceBinding.device_id == Device.device_id)
            .join(UserStudentLink, UserStudentLink.student_id == DeviceBinding.student_id)
            .where(
                DeviceBinding.active.is_(True),
                UserStudentLink.user_id == current_user.user_id,
            )
            .order_by(Device.device_id)
        )
        devices = list(db.scalars(stmt))

    return {"ok": True, "items": [device_out(device).model_dump() for device in devices], "total": len(devices)}


@router.post("")
def create_device(
    data: DeviceCreate,
    _: User = Depends(require_roles("school_admin", "admin")),
    db: Session = Depends(get_db),
):
    existing = db.scalar(select(Device).where(Device.device_id == data.device_id))
    if existing is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Device already exists")

    device = Device(
        device_id=data.device_id,
        device_token_hash=hash_secret(data.device_token),
        device_name=data.device_id,
        firmware_version=data.firmware_version,
        model_version=data.model_version,
        online_status="unknown",
    )
    db.add(device)
    db.commit()
    db.refresh(device)
    return {"ok": True, "data": device_out(device).model_dump()}


@router.get("/{device_id}/status")
def device_status(
    device_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    device = ensure_device_access(device_id, current_user, db)
    return {"ok": True, "data": device_out(device).model_dump()}


@router.post("/pair")
def pair_device(
    data: DevicePairRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ensure_student_binding_access(data.student_id, current_user, db)
    now = utc_now()
    pending = list(
        db.scalars(
            select(DevicePairingRequest).where(
                DevicePairingRequest.device_id == data.device_id,
                DevicePairingRequest.status == "pending",
            )
        )
    )
    for item in pending:
        expire_pairing_request(item)
        if item.status == "pending" and item.requested_by_user_id != current_user.user_id:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Device already has a pending pairing request",
            )
        if item.status == "pending":
            item.status = "cancelled"
            item.error_message = "Replaced by a newer pairing request"

    pairing = DevicePairingRequest(
        pairing_id=new_public_id("PAIR"),
        device_id=data.device_id,
        student_id=data.student_id,
        requested_by_user_id=current_user.user_id,
        claim_code_hash=hash_secret(data.claim_code),
        status="pending",
        expires_at=now + timedelta(minutes=PAIRING_TTL_MINUTES),
    )
    db.add(pairing)

    device = db.scalar(select(Device).where(Device.device_id == data.device_id))
    if device is not None and device.claim_code_hash is not None:
        if not verify_secret(data.claim_code, device.claim_code_hash):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid claim code")
        binding = activate_device_binding(
            data.device_id,
            data.student_id,
            current_user.user_id,
            db,
        )
        pairing.status = "completed"
        pairing.completed_at = now
        pairing.binding_id = binding.id
        queue_claim_code_rotation(data.device_id, current_user.user_id, db)

    db.commit()
    db.refresh(pairing)
    return {"ok": True, "data": pairing_out(pairing, db).model_dump()}


@router.get("/pairings/{pairing_id}")
def get_pairing_status(
    pairing_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    pairing = db.scalar(
        select(DevicePairingRequest).where(DevicePairingRequest.pairing_id == pairing_id)
    )
    if pairing is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pairing request not found")
    if pairing.requested_by_user_id != current_user.user_id and current_user.role not in {
        "school_admin", "admin"
    }:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")
    old_status = pairing.status
    expire_pairing_request(pairing)
    if pairing.status != old_status:
        db.commit()
        db.refresh(pairing)
    return {"ok": True, "data": pairing_out(pairing, db).model_dump()}


@router.delete("/pairings/{pairing_id}")
def cancel_pairing(
    pairing_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    pairing = db.scalar(
        select(DevicePairingRequest).where(DevicePairingRequest.pairing_id == pairing_id)
    )
    if pairing is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pairing request not found")
    if pairing.requested_by_user_id != current_user.user_id and current_user.role != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")
    expire_pairing_request(pairing)
    if pairing.status == "pending":
        pairing.status = "cancelled"
        pairing.error_message = "Cancelled by user"
        db.commit()
        db.refresh(pairing)
    return {"ok": True, "data": pairing_out(pairing, db).model_dump()}


@router.post("/bind")
def bind_device(
    data: DeviceBindRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    device = db.scalar(select(Device).where(Device.device_id == data.device_id))
    if device is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Device not found")
    ensure_student_binding_access(data.student_id, current_user, db)
    if device.claim_code_hash is not None and (
        data.bind_code is None or not verify_secret(data.bind_code, device.claim_code_hash)
    ):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid bind code")
    binding = activate_device_binding(
        data.device_id,
        data.student_id,
        current_user.user_id,
        db,
    )
    db.commit()
    db.refresh(binding)
    return {"ok": True, "data": binding_out(binding).model_dump()}


def device_out(device: Device) -> DeviceOut:
    return DeviceOut(
        device_id=device.device_id,
        device_name=device.device_name,
        firmware_version=device.firmware_version,
        model_version=device.model_version,
        battery_level=device.battery_level,
        online_status=device.online_status,
        last_seen_at=device.last_seen_at.isoformat() if device.last_seen_at else None,
        config_version=device.config_version,
        applied_config_version=device.applied_config_version,
        power_source=device.power_source,
        wifi_rssi_dbm=device.wifi_rssi_dbm,
        sensor_status=sensor_status(device),
    )


def binding_out(binding: DeviceBinding) -> DeviceBindingOut:
    return DeviceBindingOut(
        device_id=binding.device_id,
        student_id=binding.student_id,
        bound_by_user_id=binding.bound_by_user_id,
        active=binding.active,
    )


def pairing_out(pairing: DevicePairingRequest, db: Session) -> DevicePairingOut:
    binding = db.get(DeviceBinding, pairing.binding_id) if pairing.binding_id is not None else None
    messages = {
        "pending": "Waiting for the device to connect and register",
        "completed": "Device binding completed",
        "expired": "Pairing request expired; please reconnect to the device hotspot",
        "failed": pairing.error_message or "Device binding failed",
        "cancelled": "Pairing request cancelled",
    }
    return DevicePairingOut(
        pairing_id=pairing.pairing_id,
        device_id=pairing.device_id,
        student_id=pairing.student_id,
        status=pairing.status,
        expires_at=pairing.expires_at.isoformat(),
        completed_at=pairing.completed_at.isoformat() if pairing.completed_at else None,
        binding=binding_out(binding) if binding else None,
        message=messages[pairing.status],
    )
