from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from ..config import API_PREFIX
from ..db import get_db
from ..models import Notification, ScheduledReportRun, User, UserStudentLink, utc_now
from ..schemas import NotificationCreate, NotificationOut
from ..services.auth import get_current_user, new_public_id, require_roles

router = APIRouter(prefix=f"{API_PREFIX}/notifications", tags=["notifications"])


@router.get("")
def list_notifications(
    unread_only: bool = Query(False),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    stmt = select(Notification)
    if current_user.role not in ("school_admin", "doctor", "admin"):
        visible_student_ids = set(
            db.scalars(select(UserStudentLink.student_id).where(UserStudentLink.user_id == current_user.user_id))
        )
        stmt = stmt.where(
            or_(
                Notification.user_id == current_user.user_id,
                Notification.student_id.in_(visible_student_ids) if visible_student_ids else False,
                Notification.user_id.is_(None) & Notification.student_id.is_(None),
            )
        )
    if unread_only:
        stmt = stmt.where(Notification.read_at.is_(None))

    notifications = list(db.scalars(stmt.order_by(Notification.created_at.desc(), Notification.id.desc())))
    return {"ok": True, "items": [notification_out(item, db).model_dump() for item in notifications], "total": len(notifications)}


@router.post("")
def create_notification(
    data: NotificationCreate,
    _: User = Depends(require_roles("school_admin", "admin")),
    db: Session = Depends(get_db),
):
    notification = Notification(
        notification_id=new_public_id("NTF"),
        user_id=data.user_id,
        student_id=data.student_id,
        notification_type=data.notification_type,
        title=data.title,
        content=data.content,
    )
    db.add(notification)
    db.commit()
    db.refresh(notification)
    return {"ok": True, "data": notification_out(notification, db).model_dump()}


@router.post("/{notification_id}/read")
def mark_notification_read(
    notification_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    notification = db.scalar(select(Notification).where(Notification.notification_id == notification_id))
    if notification is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Notification not found")
    ensure_notification_access(notification, current_user, db)
    if notification.read_at is None:
        notification.read_at = utc_now()
        db.commit()
        db.refresh(notification)
    return {"ok": True, "data": notification_out(notification, db).model_dump()}


def ensure_notification_access(notification: Notification, current_user: User, db: Session) -> None:
    if current_user.role in ("school_admin", "doctor", "admin"):
        return
    if notification.user_id == current_user.user_id:
        return
    if notification.user_id is None and notification.student_id is None:
        return
    if notification.student_id is not None:
        link = db.scalar(
            select(UserStudentLink).where(
                UserStudentLink.user_id == current_user.user_id,
                UserStudentLink.student_id == notification.student_id,
            )
        )
        if link is not None:
            return
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")


def notification_out(notification: Notification, db: Session) -> NotificationOut:
    scheduled_run = db.scalar(
        select(ScheduledReportRun).where(
            ScheduledReportRun.notification_id == notification.notification_id
        )
    )
    return NotificationOut(
        notification_id=notification.notification_id,
        user_id=notification.user_id,
        student_id=notification.student_id,
        notification_type=notification.notification_type,
        title=notification.title,
        content=notification.content,
        is_read=notification.read_at is not None,
        related_report_id=scheduled_run.report_id if scheduled_run else None,
        created_at=notification.created_at.isoformat(),
        read_at=notification.read_at.isoformat() if notification.read_at else None,
    )
