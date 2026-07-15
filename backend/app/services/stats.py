from datetime import date, datetime, time, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import DailyStat, PostureRecord

POOR_POSTURES = {"left_lean", "right_lean", "front_lean", "back_lean"}
CHINA_TZ = timezone(timedelta(hours=8), name="Asia/Shanghai")


def calculate_daily_stat(
    student_id: str,
    stat_date: date,
    db: Session,
    commit: bool = True,
) -> DailyStat:
    start_ms = int(datetime.combine(stat_date, time.min, tzinfo=CHINA_TZ).timestamp() * 1000)
    end_ms = int(datetime.combine(stat_date, time.max, tzinfo=CHINA_TZ).timestamp() * 1000)

    records = list(
        db.scalars(
            select(PostureRecord)
            .where(
                PostureRecord.student_id == student_id,
                PostureRecord.timestamp_ms >= start_ms,
                PostureRecord.timestamp_ms <= end_ms,
            )
            .order_by(PostureRecord.timestamp_ms, PostureRecord.id)
        )
    )

    durations = estimate_posture_durations(records)
    normal_sitting_s = durations.get("normal", 0)
    poor_sitting_s = sum(durations.get(posture, 0) for posture in POOR_POSTURES)
    total_sitting_s = normal_sitting_s + poor_sitting_s
    normal_ratio = round(normal_sitting_s / total_sitting_s, 4) if total_sitting_s else 0.0

    asymmetry_values = [r.asymmetry_index for r in records if r.posture != "empty"]
    avg_asymmetry_index = round(sum(asymmetry_values) / len(asymmetry_values), 4) if asymmetry_values else 0.0
    reminder_count = estimate_reminder_count(records)
    max_poor_posture_duration_s = estimate_max_continuous_poor_duration(records)

    stat = db.scalar(select(DailyStat).where(DailyStat.student_id == student_id, DailyStat.stat_date == stat_date))
    if stat is None:
        stat = DailyStat(student_id=student_id, stat_date=stat_date)
        db.add(stat)

    stat.total_sitting_s = total_sitting_s
    stat.normal_sitting_s = normal_sitting_s
    stat.poor_sitting_s = poor_sitting_s
    stat.normal_ratio = normal_ratio
    stat.left_lean_count = count_transitions(records, "left_lean")
    stat.right_lean_count = count_transitions(records, "right_lean")
    stat.front_lean_count = count_transitions(records, "front_lean")
    stat.back_lean_count = count_transitions(records, "back_lean")
    stat.reminder_count = reminder_count
    stat.avg_asymmetry_index = avg_asymmetry_index
    stat.max_poor_posture_duration_s = max_poor_posture_duration_s
    if commit:
        db.commit()
        db.refresh(stat)
    else:
        db.flush()
    return stat


def count_transitions(records: list[PostureRecord], posture: str) -> int:
    count = 0
    previous = None
    for record in records:
        if record.posture == posture and previous != posture:
            count += 1
        previous = record.posture
    return count


def estimate_posture_durations(records: list[PostureRecord]) -> dict[str, int]:
    durations: dict[str, int] = {}
    for session_records in records_by_session(records):
        for index, record in enumerate(session_records):
            duration = interval_duration_s(session_records, index)
            durations[record.posture] = durations.get(record.posture, 0) + duration
    return durations


def estimate_reminder_count(records: list[PostureRecord]) -> int:
    total = 0
    for session_records in records_by_session(records):
        if not session_records:
            continue
        first = session_records[0].reminder_count
        last = session_records[-1].reminder_count
        total += max(last - first, last, 0)
    return total


def estimate_max_continuous_poor_duration(records: list[PostureRecord]) -> int:
    best = 0
    for session_records in records_by_session(records):
        current = 0
        for index, record in enumerate(session_records):
            if record.posture in POOR_POSTURES:
                current += interval_duration_s(session_records, index)
                best = max(best, current)
            else:
                current = 0
    return best


def records_by_session(records: list[PostureRecord]) -> list[list[PostureRecord]]:
    groups: dict[str, list[PostureRecord]] = {}
    for record in records:
        groups.setdefault(record.session_id, []).append(record)
    return [
        sorted(session_records, key=lambda item: (item.timestamp_ms, item.id))
        for session_records in groups.values()
    ]


def interval_duration_s(session_records: list[PostureRecord], index: int) -> int:
    record = session_records[index]
    if index + 1 < len(session_records):
        diff_s = max(0, int(round((session_records[index + 1].timestamp_ms - record.timestamp_ms) / 1000)))
        if diff_s > 0:
            return min(diff_s, max(record.posture_duration_s, diff_s))
    return record.posture_duration_s


def calculate_weekly_stat(student_id: str, week_value: str, db: Session) -> dict:
    week_start = parse_week_start(week_value)
    daily_stats = [calculate_daily_stat(student_id, week_start + timedelta(days=offset), db) for offset in range(7)]
    active_stats = [stat for stat in daily_stats if stat.total_sitting_s > 0]

    total_sitting_s = sum(stat.total_sitting_s for stat in daily_stats)
    normal_sitting_s = sum(stat.normal_sitting_s for stat in daily_stats)
    poor_sitting_s = sum(stat.poor_sitting_s for stat in daily_stats)
    normal_ratio = round(normal_sitting_s / total_sitting_s, 4) if total_sitting_s else 0.0

    return {
        "student_id": student_id,
        "week": f"{week_start.isocalendar().year}-W{week_start.isocalendar().week:02d}",
        "period_start": week_start.isoformat(),
        "period_end": (week_start + timedelta(days=6)).isoformat(),
        "total_sitting_s": total_sitting_s,
        "normal_sitting_s": normal_sitting_s,
        "poor_sitting_s": poor_sitting_s,
        "normal_ratio": normal_ratio,
        "left_lean_count": sum(stat.left_lean_count for stat in daily_stats),
        "right_lean_count": sum(stat.right_lean_count for stat in daily_stats),
        "front_lean_count": sum(stat.front_lean_count for stat in daily_stats),
        "back_lean_count": sum(stat.back_lean_count for stat in daily_stats),
        "reminder_count": sum(stat.reminder_count for stat in daily_stats),
        "avg_asymmetry_index": round(
            sum(stat.avg_asymmetry_index for stat in active_stats) / len(active_stats),
            4,
        ) if active_stats else 0.0,
        "max_poor_posture_duration_s": max((stat.max_poor_posture_duration_s for stat in daily_stats), default=0),
        "daily_items": [
            {
                "date": stat.stat_date.isoformat(),
                "total_sitting_s": stat.total_sitting_s,
                "normal_sitting_s": stat.normal_sitting_s,
                "poor_sitting_s": stat.poor_sitting_s,
                "normal_ratio": stat.normal_ratio,
                "reminder_count": stat.reminder_count,
                "avg_asymmetry_index": stat.avg_asymmetry_index,
            }
            for stat in daily_stats
        ],
    }


def parse_week_start(week_value: str) -> date:
    if "-W" in week_value:
        year_text, week_text = week_value.split("-W", 1)
        return date.fromisocalendar(int(year_text), int(week_text), 1)
    return date.fromisoformat(week_value)
