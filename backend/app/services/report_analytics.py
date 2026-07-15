from datetime import date, datetime, time, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import PostureRecord

CHINA_TZ = timezone(timedelta(hours=8), name="Asia/Shanghai")
POSTURES = ("normal", "left_lean", "right_lean", "front_lean", "back_lean")
ABNORMAL_POSTURES = set(POSTURES[1:])
MAX_CONFIRMED_SLICE_S = 10


def latest_records(student_id: str, limit: int, db: Session) -> list[PostureRecord]:
    unique_record_ids = (
        select(func.max(PostureRecord.id).label("record_id"))
        .where(PostureRecord.student_id == student_id)
        .group_by(PostureRecord.device_id, PostureRecord.session_id, PostureRecord.seq)
        .subquery()
    )
    records = list(
        db.scalars(
            select(PostureRecord)
            .join(unique_record_ids, unique_record_ids.c.record_id == PostureRecord.id)
            .order_by(PostureRecord.timestamp_ms.desc(), PostureRecord.id.desc())
            .limit(limit)
        )
    )
    records.reverse()
    return records


def period_records(
    student_id: str,
    period_start: date,
    period_end: date,
    db: Session,
) -> list[PostureRecord]:
    start_ms, end_ms = local_period_ms(period_start, period_end)
    return list(
        db.scalars(
            select(PostureRecord)
            .where(
                PostureRecord.student_id == student_id,
                PostureRecord.timestamp_ms >= start_ms,
                PostureRecord.timestamp_ms < end_ms,
            )
            .order_by(PostureRecord.timestamp_ms, PostureRecord.id)
        )
    )


def summarize_records(records: list[PostureRecord]) -> tuple[dict, list[dict]]:
    if not records:
        return empty_summary(), []

    durations = {posture: 0 for posture in POSTURES}
    daily_durations: dict[str, dict[str, int]] = {}
    daily_reminders: dict[str, int] = {}
    longest_abnormal_s = 0
    compact_records: list[dict] = []
    chronological_slices: list[tuple[str, int]] = []
    asymmetry_values: list[float] = []

    for session_records in records_by_session(records):
        current_abnormal_s = 0
        previous_reminder_count: int | None = None
        for index, record in enumerate(session_records):
            duration_s = confirmed_interval_s(session_records, index)
            local_date = record_local_date(record).isoformat()
            daily = daily_durations.setdefault(local_date, {posture: 0 for posture in POSTURES})
            if record.posture in durations:
                durations[record.posture] += duration_s
                daily[record.posture] += duration_s
                chronological_slices.append((record.posture, duration_s))
            if record.posture != "empty":
                asymmetry_values.append(record.asymmetry_index)

            if record.posture in ABNORMAL_POSTURES:
                current_abnormal_s += duration_s
                longest_abnormal_s = max(longest_abnormal_s, current_abnormal_s)
            else:
                current_abnormal_s = 0

            if previous_reminder_count is not None:
                delta = max(0, record.reminder_count - previous_reminder_count)
                daily_reminders[local_date] = daily_reminders.get(local_date, 0) + delta
            previous_reminder_count = record.reminder_count

            compact_records.append(
                {
                    "t": record.timestamp_ms,
                    "p": record.posture,
                    "d": duration_s,
                    "a": round(record.asymmetry_index, 4),
                    "tx": round(record.tilt_x, 2),
                    "ty": round(record.tilt_y, 2),
                    "r": record.reminder_count,
                }
            )

    effective_s = sum(durations.values())
    posture_stats = {
        posture: {
            "duration_s": durations[posture],
            "ratio": round(durations[posture] / effective_s, 4) if effective_s else 0.0,
        }
        for posture in POSTURES
    }
    daily_items = build_daily_items(daily_durations, daily_reminders)
    reminder_count = sum(daily_reminders.values())
    peak_day = max(daily_items, key=lambda item: (item["reminder_count"], item["date"])) if daily_items else None
    trend = calculate_trend(daily_items, chronological_slices)

    return {
        "record_count": len(records),
        "data_start_at": timestamp_iso(records[0].timestamp_ms),
        "data_end_at": timestamp_iso(records[-1].timestamp_ms),
        "effective_sitting_s": effective_s,
        "normal_sitting_s": durations["normal"],
        "normal_ratio": posture_stats["normal"]["ratio"],
        "poor_sitting_s": sum(durations[p] for p in ABNORMAL_POSTURES),
        "posture_stats": posture_stats,
        "reminder_count": reminder_count,
        "reminder_peak_day": (
            {"date": peak_day["date"], "count": peak_day["reminder_count"]}
            if peak_day else None
        ),
        "max_continuous_abnormal_s": longest_abnormal_s,
        "avg_asymmetry_index": (
            round(sum(asymmetry_values) / len(asymmetry_values), 4)
            if asymmetry_values else 0.0
        ),
        "trend": trend,
        "daily_items": daily_items,
    }, compact_records


def records_by_session(records: list[PostureRecord]) -> list[list[PostureRecord]]:
    groups: dict[tuple[str, str], list[PostureRecord]] = {}
    for record in records:
        groups.setdefault((record.device_id, record.session_id), []).append(record)
    return [
        sorted(items, key=lambda item: (item.timestamp_ms, item.id))
        for items in groups.values()
    ]


def confirmed_interval_s(records: list[PostureRecord], index: int) -> int:
    record = records[index]
    if index + 1 < len(records):
        diff_s = max(0, (records[index + 1].timestamp_ms - record.timestamp_ms) // 1000)
        if diff_s > 0:
            return min(diff_s, MAX_CONFIRMED_SLICE_S)
    return min(max(record.posture_duration_s, 0), MAX_CONFIRMED_SLICE_S)


def build_daily_items(
    daily_durations: dict[str, dict[str, int]],
    daily_reminders: dict[str, int],
) -> list[dict]:
    items = []
    for date_value in sorted(daily_durations):
        durations = daily_durations[date_value]
        effective_s = sum(durations.values())
        poor_s = sum(durations[p] for p in ABNORMAL_POSTURES)
        items.append(
            {
                "date": date_value,
                "effective_sitting_s": effective_s,
                "normal_sitting_s": durations["normal"],
                "normal_ratio": round(durations["normal"] / effective_s, 4) if effective_s else 0.0,
                "poor_sitting_s": poor_s,
                "poor_ratio": round(poor_s / effective_s, 4) if effective_s else 0.0,
                "reminder_count": daily_reminders.get(date_value, 0),
            }
        )
    return items


def calculate_trend(
    daily_items: list[dict],
    chronological_slices: list[tuple[str, int]] | None = None,
) -> dict:
    active_items = [item for item in daily_items if item["effective_sitting_s"] > 0]
    if len(active_items) >= 2:
        split = max(1, len(active_items) // 2)
        first = active_items[:split]
        second = active_items[split:] or active_items[-1:]
        first_ratio = weighted_poor_ratio(first)
        second_ratio = weighted_poor_ratio(second)
    elif chronological_slices and len(chronological_slices) >= 2:
        split = max(1, len(chronological_slices) // 2)
        first_ratio = slice_poor_ratio(chronological_slices[:split])
        second_ratio = slice_poor_ratio(chronological_slices[split:] or chronological_slices[-1:])
    else:
        return {
            "direction": "insufficient_data",
            "description": "有效数据不足，暂无法判断姿态变化趋势。",
            "first_half_poor_ratio": None,
            "second_half_poor_ratio": None,
        }
    delta = second_ratio - first_ratio
    if delta <= -0.05:
        direction = "improving"
        description = "后半段非标准坐姿比例下降，姿态表现有所改善。"
    elif delta >= 0.05:
        direction = "worsening"
        description = "后半段非标准坐姿比例上升，姿态表现有所变差。"
    else:
        direction = "stable"
        description = "前后半段非标准坐姿比例变化不大，姿态表现基本稳定。"
    return {
        "direction": direction,
        "description": description,
        "first_half_poor_ratio": round(first_ratio, 4),
        "second_half_poor_ratio": round(second_ratio, 4),
    }


def weighted_poor_ratio(items: list[dict]) -> float:
    effective_s = sum(item["effective_sitting_s"] for item in items)
    poor_s = sum(item["poor_sitting_s"] for item in items)
    return poor_s / effective_s if effective_s else 0.0


def slice_poor_ratio(slices: list[tuple[str, int]]) -> float:
    effective_s = sum(duration_s for _, duration_s in slices)
    poor_s = sum(duration_s for posture, duration_s in slices if posture in ABNORMAL_POSTURES)
    return poor_s / effective_s if effective_s else 0.0


def empty_summary() -> dict:
    return {
        "record_count": 0,
        "effective_sitting_s": 0,
        "normal_sitting_s": 0,
        "normal_ratio": 0.0,
        "poor_sitting_s": 0,
        "posture_stats": {
            posture: {"duration_s": 0, "ratio": 0.0} for posture in POSTURES
        },
        "reminder_count": 0,
        "reminder_peak_day": None,
        "max_continuous_abnormal_s": 0,
        "avg_asymmetry_index": 0.0,
        "trend": calculate_trend([], []),
        "daily_items": [],
    }


def local_period_ms(period_start: date, period_end: date) -> tuple[int, int]:
    start = datetime.combine(period_start, time.min, tzinfo=CHINA_TZ).astimezone(timezone.utc)
    end = datetime.combine(period_end + timedelta(days=1), time.min, tzinfo=CHINA_TZ).astimezone(timezone.utc)
    return int(start.timestamp() * 1000), int(end.timestamp() * 1000)


def record_local_date(record: PostureRecord) -> date:
    return datetime.fromtimestamp(record.timestamp_ms / 1000, timezone.utc).astimezone(CHINA_TZ).date()


def timestamp_iso(timestamp_ms: int) -> str:
    return datetime.fromtimestamp(timestamp_ms / 1000, timezone.utc).astimezone(CHINA_TZ).isoformat()
