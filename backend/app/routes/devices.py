from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import API_PREFIX
from ..db import get_db
from ..models import Device, DeviceBinding, Student, User, UserStudentLink, utc_now
from ..schemas import DeviceBindRequest, DeviceBindingOut, DeviceCreate, DeviceOut
from ..services.auth import get_current_user, hash_secret, require_roles

router = APIRouter(prefix=f"{API_PREFIX}/devices", tags=["devices"])


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
    device = db.scalar(select(Device).where(Device.device_id == device_id))
    if device is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Device not found")
    return {"ok": True, "data": device_out(device).model_dump()}


@router.post("/bind")
def bind_device(
    data: DeviceBindRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    device = db.scalar(select(Device).where(Device.device_id == data.device_id))
    if device is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Device not found")

    student = db.scalar(select(Student).where(Student.student_id == data.student_id))
    if student is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Student not found")

    if current_user.role == "parent":
        link = db.scalar(
            select(UserStudentLink).where(
                UserStudentLink.user_id == current_user.user_id,
                UserStudentLink.student_id == data.student_id,
            )
        )
        if link is None:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")

    existing = db.scalar(
        select(DeviceBinding).where(
            DeviceBinding.device_id == data.device_id,
            DeviceBinding.student_id == data.student_id,
            DeviceBinding.active.is_(True),
        )
    )
    if existing is not None:
        conflicting = db.scalars(
            select(DeviceBinding).where(
                DeviceBinding.student_id == data.student_id,
                DeviceBinding.device_id != data.device_id,
                DeviceBinding.active.is_(True),
            )
        )
        changed = False
        for old in conflicting:
            old.active = False
            old.unbound_at = utc_now()
            changed = True
        if changed:
            db.commit()
            db.refresh(existing)
        return {"ok": True, "data": binding_out(existing).model_dump()}

    old_bindings = db.scalars(
        select(DeviceBinding).where(
            (
                (DeviceBinding.device_id == data.device_id)
                | (DeviceBinding.student_id == data.student_id)
            ),
            DeviceBinding.active.is_(True),
        )
    )
    for old in old_bindings:
        old.active = False
        old.unbound_at = utc_now()

    binding = DeviceBinding(
        device_id=data.device_id,
        student_id=data.student_id,
        bound_by_user_id=current_user.user_id,
        active=True,
    )
    db.add(binding)
    db.commit()
    db.refresh(binding)
    return {"ok": True, "data": binding_out(binding).model_dump()}


def device_out(device: Device) -> DeviceOut:
    return DeviceOut(
        device_id=device.device_id,
        firmware_version=device.firmware_version,
        model_version=device.model_version,
        battery_level=device.battery_level,
        online_status=device.online_status,
        last_seen_at=device.last_seen_at.isoformat() if device.last_seen_at else None,
    )


def binding_out(binding: DeviceBinding) -> DeviceBindingOut:
    return DeviceBindingOut(
        device_id=binding.device_id,
        student_id=binding.student_id,
        bound_by_user_id=binding.bound_by_user_id,
        active=binding.active,
    )
