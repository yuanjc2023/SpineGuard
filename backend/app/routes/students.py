from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import API_PREFIX
from ..db import get_db
from ..models import Report, Student, User, UserStudentLink
from ..schemas import DailyStatOut, ReportGenerateRequest, StudentCreate, StudentOut
from ..services.auth import get_current_user, new_public_id
from ..services.reports import generate_latest_smart_report, generate_report, list_reports, report_to_dict
from ..services.risk import assess_risk, risk_to_dict
from ..services.stats import calculate_daily_stat, calculate_weekly_stat
from ..services.telemetry import get_student_history, get_student_latest

router = APIRouter(prefix=f"{API_PREFIX}/students", tags=["students"])


@router.get("")
def list_students(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if current_user.role in ("school_admin", "doctor", "admin"):
        students = list(db.scalars(select(Student).order_by(Student.student_id)))
    else:
        stmt = (
            select(Student)
            .join(UserStudentLink, UserStudentLink.student_id == Student.student_id)
            .where(UserStudentLink.user_id == current_user.user_id)
            .order_by(Student.student_id)
        )
        students = list(db.scalars(stmt))

    return {"ok": True, "items": [student_out(student).model_dump() for student in students], "total": len(students)}


@router.post("")
def create_student(
    data: StudentCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    student = Student(
        student_id=new_public_id("STU"),
        display_code=data.display_code,
        school_id=data.school_id,
        class_id=data.class_id,
    )
    db.add(student)

    if current_user.role == "parent":
        db.add(UserStudentLink(user_id=current_user.user_id, student_id=student.student_id, relation="guardian"))

    db.commit()
    db.refresh(student)
    return {"ok": True, "data": student_out(student).model_dump()}


@router.get("/{student_id}")
def get_student(
    student_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    student = db.scalar(select(Student).where(Student.student_id == student_id))
    if student is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Student not found")

    if current_user.role == "parent":
        link = db.scalar(
            select(UserStudentLink).where(
                UserStudentLink.user_id == current_user.user_id,
                UserStudentLink.student_id == student_id,
            )
        )
        if link is None:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")

    return {"ok": True, "data": student_out(student).model_dump()}


@router.get("/{student_id}/latest")
def student_latest(
    student_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ensure_student_access(student_id, current_user, db)
    return {"ok": True, "data": get_student_latest(student_id, db)}


@router.get("/{student_id}/history")
def student_history(
    student_id: str,
    limit: int = Query(100, ge=1, le=2000),
    from_value: str | None = Query(default=None, alias="from"),
    to_value: str | None = Query(default=None, alias="to"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ensure_student_access(student_id, current_user, db)
    try:
        items = get_student_history(student_id, limit, db, from_value, to_value)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, "items": items}


@router.get("/{student_id}/stats/daily")
def student_daily_stat(
    student_id: str,
    date_value: date = Query(alias="date"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ensure_student_access(student_id, current_user, db)
    stat = calculate_daily_stat(student_id, date_value, db)
    return {"ok": True, "data": daily_stat_out(stat).model_dump()}


@router.get("/{student_id}/stats/weekly")
def student_weekly_stat(
    student_id: str,
    week: str = Query(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ensure_student_access(student_id, current_user, db)
    try:
        stat = calculate_weekly_stat(student_id, week, db)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="week must be YYYY-Www or YYYY-MM-DD") from exc
    return {"ok": True, "data": stat}


@router.get("/{student_id}/risk")
def student_risk(
    student_id: str,
    date_value: date = Query(alias="date"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ensure_student_access(student_id, current_user, db)
    assessment = assess_risk(student_id, date_value, db)
    return {"ok": True, "data": risk_to_dict(assessment)}


@router.get("/{student_id}/reports")
def student_reports(
    student_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ensure_student_access(student_id, current_user, db)
    reports = list_reports(student_id, db)
    return {"ok": True, "items": [report_to_dict(report) for report in reports], "total": len(reports)}


@router.get("/{student_id}/reports/{report_id}")
def student_report_detail(
    student_id: str,
    report_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ensure_student_access(student_id, current_user, db)
    report = db.scalar(
        select(Report).where(Report.id == report_id, Report.student_id == student_id)
    )
    if report is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Report not found")
    return {"ok": True, "data": report_to_dict(report)}


@router.post("/{student_id}/reports/generate")
def student_report_generate(
    student_id: str,
    data: ReportGenerateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ensure_student_access(student_id, current_user, db)
    if data.report_type == "smart":
        try:
            report = generate_latest_smart_report(student_id, data.record_limit, db)
        except ValueError as exc:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No posture records available") from exc
        return {"ok": True, "data": report_to_dict(report)}
    end_date = date.fromisoformat(data.date) if data.date else date.today()
    report = generate_report(student_id, data.report_type, end_date, data.use_llm, db)
    return {"ok": True, "data": report_to_dict(report)}


def student_out(student: Student) -> StudentOut:
    return StudentOut(
        student_id=student.student_id,
        display_code=student.display_code,
        school_id=student.school_id,
        class_id=student.class_id,
    )


def daily_stat_out(stat) -> DailyStatOut:
    return DailyStatOut(
        student_id=stat.student_id,
        stat_date=stat.stat_date.isoformat(),
        total_sitting_s=stat.total_sitting_s,
        normal_sitting_s=stat.normal_sitting_s,
        poor_sitting_s=stat.poor_sitting_s,
        normal_ratio=stat.normal_ratio,
        left_lean_count=stat.left_lean_count,
        right_lean_count=stat.right_lean_count,
        front_lean_count=stat.front_lean_count,
        back_lean_count=stat.back_lean_count,
        reminder_count=stat.reminder_count,
        avg_asymmetry_index=stat.avg_asymmetry_index,
        max_poor_posture_duration_s=stat.max_poor_posture_duration_s,
    )


def ensure_student_access(student_id: str, current_user: User, db: Session) -> Student:
    student = db.scalar(select(Student).where(Student.student_id == student_id))
    if student is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Student not found")

    if current_user.role in ("school_admin", "doctor", "admin"):
        return student

    link = db.scalar(
        select(UserStudentLink).where(
            UserStudentLink.user_id == current_user.user_id,
            UserStudentLink.student_id == student_id,
        )
    )
    if link is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")
    return student
