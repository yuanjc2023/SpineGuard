import json
from datetime import date, datetime, time, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..models import Notification, PostureRecord, Report, ScheduledReportRun, utc_now
from .auth import new_public_id
from .game import CHINA_TZ
from .reports import generate_llm_report, generate_report, rule_report_content

REPORT_SCHEDULES = {
    "daily": time(0, 10),
    "weekly": time(0, 20),
    "monthly": time(0, 30),
}


def run_due_reports(
    db: Session,
    now: datetime | None = None,
    use_llm: bool = True,
    catch_up_days: int = 1,
) -> list[dict]:
    now = now or utc_now()
    local_now = as_utc(now).astimezone(CHINA_TZ)
    results: list[dict] = []
    for report_type, period_start, period_end, scheduled_for in due_periods(local_now, catch_up_days):
        for student_id in students_with_data(period_start, period_end, db):
            result = generate_scheduled_report(
                student_id,
                report_type,
                period_start,
                period_end,
                scheduled_for,
                use_llm,
                db,
            )
            if result is not None:
                results.append(result)
    return results


def due_periods(local_now: datetime, catch_up_days: int) -> list[tuple[str, date, date, datetime]]:
    periods: list[tuple[str, date, date, datetime]] = []
    last_complete_day = local_now.date() - timedelta(days=1)
    for offset in range(max(1, catch_up_days)):
        period_end = last_complete_day - timedelta(days=offset)
        schedule_date = period_end + timedelta(days=1)
        scheduled_for = scheduled_datetime(schedule_date, "daily")
        if local_now.astimezone(timezone.utc) >= scheduled_for:
            periods.append(("daily", period_end, period_end, scheduled_for))

    current_week_start = local_now.date() - timedelta(days=local_now.weekday())
    period_end = current_week_start - timedelta(days=1)
    period_start = period_end - timedelta(days=6)
    scheduled_for = scheduled_datetime(current_week_start, "weekly")
    if local_now.astimezone(timezone.utc) >= scheduled_for:
        periods.append(("weekly", period_start, period_end, scheduled_for))

    current_month_start = local_now.date().replace(day=1)
    period_end = current_month_start - timedelta(days=1)
    period_start = period_end.replace(day=1)
    scheduled_for = scheduled_datetime(current_month_start, "monthly")
    if local_now.astimezone(timezone.utc) >= scheduled_for:
        periods.append(("monthly", period_start, period_end, scheduled_for))
    return periods


def scheduled_datetime(local_date: date, report_type: str) -> datetime:
    return datetime.combine(local_date, REPORT_SCHEDULES[report_type], tzinfo=CHINA_TZ).astimezone(timezone.utc)


def students_with_data(period_start: date, period_end: date, db: Session) -> list[str]:
    start_ms, end_ms = local_period_ms(period_start, period_end)
    return list(
        db.scalars(
            select(PostureRecord.student_id)
            .where(
                PostureRecord.student_id.is_not(None),
                PostureRecord.timestamp_ms >= start_ms,
                PostureRecord.timestamp_ms < end_ms,
            )
            .distinct()
            .order_by(PostureRecord.student_id)
        )
    )


def generate_scheduled_report(
    student_id: str,
    report_type: str,
    period_start: date,
    period_end: date,
    scheduled_for: datetime,
    use_llm: bool,
    db: Session,
) -> dict | None:
    run = db.scalar(
        select(ScheduledReportRun).where(
            ScheduledReportRun.student_id == student_id,
            ScheduledReportRun.report_type == report_type,
            ScheduledReportRun.period_start == period_start,
            ScheduledReportRun.period_end == period_end,
        )
    )
    if run is not None and run.status == "completed":
        return None
    if run is not None and run.status == "generating":
        updated_at = as_utc(run.updated_at)
        if as_utc(utc_now()) - updated_at < timedelta(minutes=5):
            return None
    if run is None:
        run = ScheduledReportRun(
            student_id=student_id,
            report_type=report_type,
            period_start=period_start,
            period_end=period_end,
            scheduled_for=scheduled_for,
            status="pending",
        )
        db.add(run)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            return None

    try:
        report = db.get(Report, run.report_id) if run.report_id else None
        if report is None:
            report = generate_report(
                student_id,
                report_type,
                period_end,
                False,
                db,
                period_start=period_start,
                commit=False,
            )
            run.report_id = report.id
        report_id = report.id
        summary = json.loads(report.summary_json)
        run.status = "generating"
        run.generated_by = report.generated_by
        run.error_message = None
        run.updated_at = utc_now()
        db.commit()

        if use_llm:
            content = generate_llm_report(summary)
            generated_by = (
                "llm_fallback" if content.startswith("【LLM 调用未完成】") else "llm"
            )
        else:
            content = rule_report_content(summary)
            generated_by = "rule"

        report = db.get(Report, report_id)
        run = db.scalar(
            select(ScheduledReportRun).where(
                ScheduledReportRun.student_id == student_id,
                ScheduledReportRun.report_type == report_type,
                ScheduledReportRun.period_start == period_start,
                ScheduledReportRun.period_end == period_end,
            )
        )
        if report is None or run is None:
            raise RuntimeError("Scheduled report state was lost")
        report.content = content
        report.generated_by = generated_by

        notification = None
        if run.notification_id:
            notification = db.scalar(
                select(Notification).where(Notification.notification_id == run.notification_id)
            )
        if notification is None:
            notification = create_report_notification(student_id, report_type, period_start, period_end)
            db.add(notification)
            db.flush()
        run.status = "completed"
        run.report_id = report.id
        run.notification_id = notification.notification_id
        run.generated_by = generated_by
        run.error_message = None
        run.finished_at = utc_now()
        db.commit()
    except Exception as exc:
        db.rollback()
        run = db.scalar(
            select(ScheduledReportRun).where(
                ScheduledReportRun.student_id == student_id,
                ScheduledReportRun.report_type == report_type,
                ScheduledReportRun.period_start == period_start,
                ScheduledReportRun.period_end == period_end,
            )
        )
        if run is None:
            run = ScheduledReportRun(
                student_id=student_id,
                report_type=report_type,
                period_start=period_start,
                period_end=period_end,
                scheduled_for=scheduled_for,
            )
            db.add(run)
        run.status = "failed"
        run.error_message = f"{exc.__class__.__name__}: {str(exc)[:500]}"
        run.finished_at = utc_now()
        db.commit()
        return {
            "student_id": student_id,
            "report_type": report_type,
            "period_start": period_start.isoformat(),
            "period_end": period_end.isoformat(),
            "status": "failed",
        }

    return {
        "student_id": student_id,
        "report_type": report_type,
        "period_start": period_start.isoformat(),
        "period_end": period_end.isoformat(),
        "status": "completed",
        "report_id": report.id,
        "notification_id": notification.notification_id,
        "generated_by": generated_by,
    }


def create_report_notification(
    student_id: str,
    report_type: str,
    period_start: date,
    period_end: date,
) -> Notification:
    labels = {"daily": "日报", "weekly": "周报", "monthly": "月报"}
    label = labels[report_type]
    return Notification(
        notification_id=new_public_id("NTF"),
        student_id=student_id,
        notification_type="report",
        title=f"坐姿{label}已生成",
        content=(
            f"{period_start.isoformat()} 至 {period_end.isoformat()} 的坐姿行为{label}已生成，"
            "可前往报告中心查看。"
        ),
    )


def local_period_ms(period_start: date, period_end: date) -> tuple[int, int]:
    start = datetime.combine(period_start, time.min, tzinfo=CHINA_TZ).astimezone(timezone.utc)
    end = datetime.combine(period_end + timedelta(days=1), time.min, tzinfo=CHINA_TZ).astimezone(timezone.utc)
    return int(start.timestamp() * 1000), int(end.timestamp() * 1000)


def as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)
