import json
import math
from datetime import date, datetime, time, timedelta, timezone
from uuid import uuid4

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from ..models import (
    AbnormalEpisode,
    DailyTaskState,
    Device,
    DeviceSessionState,
    GameDailyProgress,
    GardenAccount,
    GrowthSettlementSegment,
    IdempotencyRecord,
    MilestoneClaim,
    ReminderEvent,
    RewardLedger,
    utc_now,
)

CHINA_TZ = timezone(timedelta(hours=8), name="Asia/Shanghai")
RULE_VERSION = "garden-v1"
ABNORMAL_POSTURES = {"left_lean", "right_lean", "front_lean", "back_lean"}
EFFECTIVE_POSTURES = ABNORMAL_POSTURES | {"normal"}
MAX_INTERVAL_S = 10
OFFLINE_DISPLAY_S = 10
OFFLINE_END_S = 300
EMPTY_END_S = 900
DAILY_GROWTH_CAP = 180

MILESTONE_REWARDS = {
    5: (1, 0, 0),
    15: (0, 3, 0),
    30: (0, 3, 3),
    45: (3, 3, 3),
    60: (3, 3, 6),
}
TASK_RULES = {
    "daily_normal_30": {"target": 1800, "reward": (0, 0, 6, 0), "manual": True},
    "continuous_25": {"target": 1500, "reward": (0, 3, 3, 0), "manual": True},
    "daily_reminder_lt_5": {"target": 1800, "reward": (0, 0, 0, 3), "manual": False},
    "active_rest_after_60": {"target": 300, "reward": (0, 2, 0, 0), "manual": False},
}
ACTION_RULES = {
    "sunbathe": {"sunshine": -3, "water": 0, "nutrient": 0, "growth": 10},
    "water": {"sunshine": 0, "water": -5, "nutrient": 0, "growth": 15},
    "fertilize": {"sunshine": 0, "water": 0, "nutrient": -3, "growth": 30},
    "recover_tree": {"sunshine": -2, "water": 0, "nutrient": -3, "growth": 0},
}


class GameConflict(Exception):
    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(message)


def local_date_from_ms(timestamp_ms: int) -> date:
    return datetime.fromtimestamp(timestamp_ms / 1000, tz=timezone.utc).astimezone(CHINA_TZ).date()


def china_now() -> datetime:
    return datetime.now(timezone.utc).astimezone(CHINA_TZ)


def get_or_create_account(student_id: str, db: Session) -> GardenAccount:
    account = db.scalar(select(GardenAccount).where(GardenAccount.student_id == student_id))
    if account is None:
        account = GardenAccount(student_id=student_id)
        db.add(account)
        db.flush()
    return account


def get_or_create_progress(student_id: str, local_date: date, db: Session) -> GameDailyProgress:
    progress = db.scalar(
        select(GameDailyProgress).where(
            GameDailyProgress.student_id == student_id,
            GameDailyProgress.local_date == local_date,
        )
    )
    if progress is None:
        progress = GameDailyProgress(student_id=student_id, local_date=local_date)
        db.add(progress)
        db.flush()
    return progress


def get_or_create_task(student_id: str, local_date: date, task_code: str, db: Session) -> DailyTaskState:
    task = db.scalar(
        select(DailyTaskState).where(
            DailyTaskState.student_id == student_id,
            DailyTaskState.local_date == local_date,
            DailyTaskState.task_code == task_code,
        )
    )
    if task is None:
        task = DailyTaskState(
            student_id=student_id,
            local_date=local_date,
            task_code=task_code,
            target_value=TASK_RULES[task_code]["target"],
        )
        db.add(task)
        db.flush()
    return task


def process_telemetry(data, student_id: str | None, db: Session, received_at: datetime | None = None) -> list[dict]:
    if student_id is None:
        return []

    received_at = received_at or utc_now()
    account = get_or_create_account(student_id, db)
    session = db.scalar(
        select(DeviceSessionState).where(
            DeviceSessionState.device_id == data.device_id,
            DeviceSessionState.device_session_id == data.session_id,
        )
    )
    if session is None:
        close_other_sessions(data.device_id, data.session_id, db, received_at)
        session = DeviceSessionState(
            device_id=data.device_id,
            student_id=student_id,
            device_session_id=data.session_id,
            started_at_ms=data.timestamp_ms,
            last_telemetry_at_ms=data.timestamp_ms,
            last_received_at=received_at,
            current_posture=data.posture,
            current_posture_since_ms=data.timestamp_ms,
            last_seq=data.seq,
        )
        db.add(session)
        db.flush()
        if data.posture in ABNORMAL_POSTURES:
            start_abnormal_episode(session, data.posture, data.timestamp_ms, db)
        elif data.posture == "empty":
            session.empty_since_ms = data.timestamp_ms
        elif data.posture == "unknown":
            session.unknown_since_ms = data.timestamp_ms
        initialize_daily_tasks(student_id, local_date_from_ms(data.timestamp_ms), db)
        return [{"event": "posture.state_changed", "data": {"posture": data.posture}}]

    was_offline = (received_at - as_utc(session.last_received_at)).total_seconds() >= OFFLINE_DISPLAY_S
    session.last_received_at = received_at
    if session.status != "active":
        return []
    if data.seq <= session.last_seq or data.timestamp_ms <= session.last_telemetry_at_ms:
        return []

    interval_s = min(MAX_INTERVAL_S, max(0, (data.timestamp_ms - session.last_telemetry_at_ms) // 1000))
    events: list[dict] = []
    if was_offline:
        events.append({"event": "device.online", "data": {"device_id": data.device_id}})
    if interval_s:
        process_interval(session, session.last_telemetry_at_ms, interval_s, account, db, events)

    previous_posture = session.current_posture
    if data.posture != previous_posture:
        transition_posture(session, data.posture, data.timestamp_ms, account, db, events)
        events.append({"event": "posture.state_changed", "data": {"posture": data.posture}})

    session.last_seq = data.seq
    session.last_telemetry_at_ms = data.timestamp_ms
    grant_continuous_milestones(session, account, db, events)
    refresh_live_tasks(session, db)
    return events


def close_other_sessions(device_id: str, new_session_id: str, db: Session, ended_at: datetime) -> None:
    sessions = db.scalars(
        select(DeviceSessionState).where(
            DeviceSessionState.device_id == device_id,
            DeviceSessionState.device_session_id != new_session_id,
            DeviceSessionState.status == "active",
        )
    )
    for session in sessions:
        end_session(session, "ended", ended_at, db)


def process_interval(
    session: DeviceSessionState,
    interval_start_ms: int,
    interval_s: int,
    account: GardenAccount,
    db: Session,
    events: list[dict],
) -> None:
    posture = session.current_posture
    add_daily_interval(session.student_id, interval_start_ms, interval_s, posture, db)
    if posture in EFFECTIVE_POSTURES:
        session.effective_measurement_s += interval_s

    if posture == "normal":
        session.session_normal_s += interval_s
        if session.abnormal_episode_id:
            session.normal_recovery_s += interval_s
            if session.normal_recovery_s >= 5:
                stable_at = interval_start_ms + max(0, interval_s - (session.normal_recovery_s - 5)) * 1000
                after_stable_s = max(0, session.normal_recovery_s - 5)
                close_abnormal_episode(session, stable_at, "recovered", db)
                session.continuous_normal_s = session.continuous_snapshot_s + after_stable_s
                if session.severe_recovery_pending:
                    account.recovery_needed = True
                    session.severe_recovery_pending = False
                    events.append({"event": "garden.updated", "data": {"recovery_needed": True}})
        else:
            session.continuous_normal_s += interval_s
            if session.severe_recovery_pending:
                session.normal_recovery_s += interval_s
                if session.normal_recovery_s >= 5:
                    account.recovery_needed = True
                    session.severe_recovery_pending = False
                    session.normal_recovery_s = 0
                    events.append({"event": "garden.updated", "data": {"recovery_needed": True}})
    elif posture in ABNORMAL_POSTURES:
        update_abnormal_episode(session, interval_start_ms + interval_s * 1000, db, events)
    elif posture == "empty":
        session.empty_duration_s += interval_s
        if session.empty_duration_s >= 300 and session.effective_measurement_s >= 3600:
            auto_grant_task(session.student_id, local_date_from_ms(interval_start_ms), "active_rest_after_60", db, events)
        if session.empty_duration_s >= EMPTY_END_S:
            end_session(session, "empty_timeout", utc_now(), db)
    elif posture == "unknown":
        session.unknown_duration_s += interval_s
        if session.unknown_duration_s >= 60 and not session.unknown_notified:
            session.unknown_notified = True
            events.append({"event": "posture.state_changed", "data": {"posture": "unknown", "unavailable": True}})


def add_daily_interval(student_id: str, start_ms: int, duration_s: int, posture: str, db: Session) -> None:
    cursor_ms = start_ms
    remaining_s = duration_s
    while remaining_s > 0:
        local_dt = datetime.fromtimestamp(cursor_ms / 1000, tz=timezone.utc).astimezone(CHINA_TZ)
        next_midnight = datetime.combine(local_dt.date() + timedelta(days=1), time.min, tzinfo=CHINA_TZ)
        until_midnight_s = max(1, int((next_midnight - local_dt).total_seconds()))
        slice_s = min(remaining_s, until_midnight_s)
        progress = get_or_create_progress(student_id, local_dt.date(), db)
        initialize_daily_tasks(student_id, local_dt.date(), db)
        if posture == "normal":
            progress.normal_s += slice_s
        if posture in EFFECTIVE_POSTURES:
            progress.effective_measurement_s += slice_s
        cursor_ms += slice_s * 1000
        remaining_s -= slice_s


def transition_posture(
    session: DeviceSessionState,
    new_posture: str,
    timestamp_ms: int,
    account: GardenAccount,
    db: Session,
    events: list[dict],
) -> None:
    old_posture = session.current_posture
    if new_posture in ABNORMAL_POSTURES:
        if session.abnormal_episode_id is None:
            start_abnormal_episode(session, new_posture, timestamp_ms, db)
        else:
            episode = active_episode(session, db)
            if episode:
                episode.last_posture = new_posture
        session.normal_recovery_since_ms = None
        session.normal_recovery_s = 0
    elif new_posture == "normal":
        if session.abnormal_episode_id:
            session.normal_recovery_since_ms = timestamp_ms
        session.empty_since_ms = None
        session.unknown_since_ms = None
    elif new_posture in {"empty", "unknown"}:
        if session.abnormal_episode_id:
            episode = active_episode(session, db)
            if episode and episode.continuous_reset:
                session.continuous_normal_s = 0
                session.severe_recovery_pending = True
            else:
                session.continuous_normal_s = session.continuous_snapshot_s
            close_abnormal_episode(session, timestamp_ms, "interrupted", db)
        if new_posture == "empty":
            session.empty_since_ms = timestamp_ms
            session.empty_duration_s = 0
            session.unknown_since_ms = None
            session.unknown_duration_s = 0
        else:
            session.unknown_since_ms = timestamp_ms
            session.unknown_duration_s = 0
            session.unknown_notified = False
            session.empty_since_ms = None
            session.empty_duration_s = 0

    if old_posture in {"empty", "unknown"} and new_posture not in {"empty", "unknown"}:
        session.empty_since_ms = None
        session.empty_duration_s = 0
        session.unknown_since_ms = None
        session.unknown_duration_s = 0
        session.unknown_notified = False
    session.current_posture = new_posture
    session.current_posture_since_ms = timestamp_ms


def start_abnormal_episode(session: DeviceSessionState, posture: str, timestamp_ms: int, db: Session) -> None:
    episode = AbnormalEpisode(
        episode_id=f"AEP-{uuid4().hex[:20].upper()}",
        device_session_state_id=session.id,
        student_id=session.student_id,
        started_at_ms=timestamp_ms,
        first_posture=posture,
        last_posture=posture,
        continuous_snapshot_s=session.continuous_normal_s,
    )
    db.add(episode)
    db.flush()
    session.abnormal_episode_id = episode.episode_id
    session.continuous_snapshot_s = session.continuous_normal_s
    session.normal_recovery_since_ms = None
    session.normal_recovery_s = 0


def active_episode(session: DeviceSessionState, db: Session) -> AbnormalEpisode | None:
    if session.abnormal_episode_id is None:
        return None
    return db.scalar(select(AbnormalEpisode).where(AbnormalEpisode.episode_id == session.abnormal_episode_id))


def update_abnormal_episode(session: DeviceSessionState, current_ms: int, db: Session, events: list[dict]) -> None:
    episode = active_episode(session, db)
    if episode is None:
        return
    interval_s = min(MAX_INTERVAL_S, max(0, (current_ms - session.last_telemetry_at_ms) // 1000))
    episode.duration_s += interval_s
    if episode.duration_s >= 30 and not episode.reminded:
        episode.reminded = True
        session.reminder_count += 1
        progress = get_or_create_progress(session.student_id, local_date_from_ms(current_ms), db)
        progress.reminder_count += 1
        db.add(
            ReminderEvent(
                device_id=session.device_id,
                student_id=session.student_id,
                timestamp_ms=current_ms,
                posture=episode.last_posture,
                reason="abnormal_posture_30s",
            )
        )
        events.append({"event": "abnormal.reminded", "data": {"episode_id": episode.episode_id}})
    if episode.duration_s >= 60 and not episode.continuous_reset:
        episode.continuous_reset = True
        session.continuous_normal_s = 0
        session.continuous_snapshot_s = 0
        session.severe_recovery_pending = True
        events.append({"event": "continuous.reset", "data": {"episode_id": episode.episode_id}})


def close_abnormal_episode(session: DeviceSessionState, ended_at_ms: int, status: str, db: Session) -> None:
    episode = active_episode(session, db)
    if episode:
        episode.ended_at_ms = ended_at_ms
        episode.status = status
    session.abnormal_episode_id = None
    session.normal_recovery_since_ms = None
    session.normal_recovery_s = 0


def end_session(session: DeviceSessionState, status: str, ended_at: datetime, db: Session) -> None:
    if session.status != "active":
        return
    if session.abnormal_episode_id:
        close_abnormal_episode(session, session.last_telemetry_at_ms, status, db)
    session.status = status
    session.ended_at = ended_at


def grant_continuous_milestones(
    session: DeviceSessionState,
    account: GardenAccount,
    db: Session,
    events: list[dict],
) -> None:
    for minute, (sunshine, water, nutrient) in MILESTONE_REWARDS.items():
        if session.continuous_normal_s < minute * 60:
            continue
        existing = db.scalar(
            select(MilestoneClaim).where(
                MilestoneClaim.device_session_state_id == session.id,
                MilestoneClaim.reward_type == "continuous",
                MilestoneClaim.milestone_minute == minute,
            )
        )
        if existing:
            continue
        ledger = apply_ledger(
            account,
            db,
            business_key=f"session:{session.id}:continuous:{minute}",
            source_type="continuous",
            source_id=f"{session.device_session_id}:{minute}",
            sunshine_delta=sunshine,
            water_delta=water,
            nutrient_delta=nutrient,
        )
        db.add(
            MilestoneClaim(
                device_session_state_id=session.id,
                student_id=session.student_id,
                milestone_minute=minute,
                ledger_id=ledger.ledger_id,
            )
        )
        events.append({"event": "milestone.granted", "data": {"minute": minute}})


def initialize_daily_tasks(student_id: str, local_date: date, db: Session) -> None:
    for task_code in TASK_RULES:
        get_or_create_task(student_id, local_date, task_code, db)


def refresh_live_tasks(session: DeviceSessionState, db: Session) -> None:
    local_date = local_date_from_ms(session.last_telemetry_at_ms)
    progress = get_or_create_progress(session.student_id, local_date, db)
    daily = get_or_create_task(session.student_id, local_date, "daily_normal_30", db)
    daily.progress_value = progress.normal_s
    if daily.status == "locked" and progress.normal_s >= daily.target_value:
        daily.status = "claimable"
    continuous = get_or_create_task(session.student_id, local_date, "continuous_25", db)
    daily_continuous_s = min(session.continuous_normal_s, progress.normal_s)
    continuous.progress_value = max(continuous.progress_value, daily_continuous_s)
    if continuous.status == "locked" and continuous.progress_value >= continuous.target_value:
        continuous.status = "claimable"


def auto_grant_task(
    student_id: str,
    local_date: date,
    task_code: str,
    db: Session,
    events: list[dict] | None = None,
) -> None:
    task = get_or_create_task(student_id, local_date, task_code, db)
    if task.status == "claimed":
        return
    account = get_or_create_account(student_id, db)
    growth, sunshine, water, nutrient = TASK_RULES[task_code]["reward"]
    ledger = apply_ledger(
        account,
        db,
        business_key=f"task:{student_id}:{local_date.isoformat()}:{task_code}",
        source_type="daily_task",
        source_id=f"{local_date.isoformat()}:{task_code}",
        growth_delta=growth,
        sunshine_delta=sunshine,
        water_delta=water,
        nutrient_delta=nutrient,
    )
    task.status = "claimed"
    task.ledger_id = ledger.ledger_id
    task.claimed_at = utc_now()
    if events is not None:
        events.append({"event": "garden.updated", "data": {"task_code": task_code}})


def apply_ledger(
    account: GardenAccount,
    db: Session,
    business_key: str,
    source_type: str,
    source_id: str,
    growth_delta: int = 0,
    sunshine_delta: int = 0,
    water_delta: int = 0,
    nutrient_delta: int = 0,
) -> RewardLedger:
    existing = db.scalar(select(RewardLedger).where(RewardLedger.business_key == business_key))
    if existing:
        return existing
    applied = False
    for _ in range(3):
        db.refresh(account)
        if min(
            account.sunshine + sunshine_delta,
            account.water + water_delta,
            account.nutrient + nutrient_delta,
        ) < 0:
            raise GameConflict("INSUFFICIENT_RESOURCE", "资源不足")
        current_version = account.version
        result = db.execute(
            update(GardenAccount)
            .where(
                GardenAccount.id == account.id,
                GardenAccount.version == current_version,
                GardenAccount.sunshine + sunshine_delta >= 0,
                GardenAccount.water + water_delta >= 0,
                GardenAccount.nutrient + nutrient_delta >= 0,
            )
            .values(
                growth=GardenAccount.growth + max(0, growth_delta),
                sunshine=GardenAccount.sunshine + sunshine_delta,
                water=GardenAccount.water + water_delta,
                nutrient=GardenAccount.nutrient + nutrient_delta,
                version=GardenAccount.version + 1,
                updated_at=utc_now(),
            )
            .execution_options(synchronize_session=False)
        )
        if result.rowcount == 1:
            db.expire(account)
            db.refresh(account)
            applied = True
            break
    if not applied:
        raise GameConflict("CONCURRENT_UPDATE", "账户正在更新，请重试")
    balance = account_balance(account)
    ledger = RewardLedger(
        ledger_id=f"LDG-{uuid4().hex[:20].upper()}",
        student_id=account.student_id,
        business_key=business_key,
        source_type=source_type,
        source_id=source_id,
        growth_delta=max(0, growth_delta),
        sunshine_delta=sunshine_delta,
        water_delta=water_delta,
        nutrient_delta=nutrient_delta,
        balance_after_json=json.dumps(balance, ensure_ascii=False),
        rule_version=RULE_VERSION,
    )
    db.add(ledger)
    db.flush()
    return ledger


def account_balance(account: GardenAccount) -> dict:
    return {
        "growth": account.growth,
        "sunshine": account.sunshine,
        "water": account.water,
        "nutrient": account.nutrient,
        "recovery_needed": account.recovery_needed,
        "version": account.version,
    }


def stage_for_growth(growth: int) -> str:
    if growth < 100:
        return "seed"
    if growth < 300:
        return "sprout"
    if growth < 600:
        return "sapling"
    if growth < 1000:
        return "tree"
    if growth < 1500:
        return "flower"
    return "fruit"


def garden_state(student_id: str, db: Session, now: datetime | None = None) -> dict:
    now = now or utc_now()
    local_today = now.astimezone(CHINA_TZ).date()
    account = get_or_create_account(student_id, db)
    progress = get_or_create_progress(student_id, local_today, db)
    initialize_daily_tasks(student_id, local_today, db)
    session = db.scalar(
        select(DeviceSessionState)
        .where(DeviceSessionState.student_id == student_id, DeviceSessionState.status == "active")
        .order_by(DeviceSessionState.last_received_at.desc())
    )
    online = False
    continuous_s = 0
    instant_state = "offline"
    if session:
        age_s = max(0, int((now - as_utc(session.last_received_at)).total_seconds()))
        online = age_s < OFFLINE_DISPLAY_S
        continuous_s = session.continuous_normal_s
        instant_state = instant_tree_state(session, db) if online else "offline"
    tasks = list(
        db.scalars(
            select(DailyTaskState)
            .where(DailyTaskState.student_id == student_id, DailyTaskState.local_date == local_today)
            .order_by(DailyTaskState.id)
        )
    )
    rate = progress.reminder_count * 1800 / max(progress.effective_measurement_s, 1800)
    return {
        "student_id": student_id,
        "growth": account.growth,
        "stage": stage_for_growth(account.growth),
        "resources": {
            "sunshine": account.sunshine,
            "water": account.water,
            "nutrient": account.nutrient,
        },
        "today_normal_s": progress.normal_s,
        "continuous_normal_s": continuous_s,
        "reminder_count": progress.reminder_count,
        "reminder_rate_30m": round(rate, 1),
        "daily_growth_granted": progress.growth_granted,
        "daily_growth_remaining": max(0, DAILY_GROWTH_CAP - progress.growth_granted),
        "device_online": online,
        "instant_tree_state": instant_state,
        "recovery_needed": account.recovery_needed,
        "tasks": [task_to_dict(task) for task in tasks],
        "rule_version": RULE_VERSION,
        "server_time": now.astimezone(CHINA_TZ).isoformat(),
        "updated_at": account.updated_at.astimezone(CHINA_TZ).isoformat(),
    }


def instant_tree_state(session: DeviceSessionState, db: Session) -> str:
    if session.current_posture in ABNORMAL_POSTURES:
        episode = active_episode(session, db)
        if episode and episode.continuous_reset:
            return "abnormal_severe"
        if episode and episode.reminded:
            return "abnormal_reminded"
        return "abnormal_mild"
    if session.current_posture == "unknown":
        return "unknown"
    if session.current_posture == "empty":
        return "resting"
    return session.current_posture


def task_to_dict(task: DailyTaskState) -> dict:
    return {
        "task_id": task.task_code,
        "status": task.status,
        "progress": task.progress_value,
        "target": task.target_value,
        "claimed_at": task.claimed_at.isoformat() if task.claimed_at else None,
    }


def claim_task(
    student_id: str,
    task_code: str,
    idempotency_key: str,
    user_id: str,
    db: Session,
) -> dict:
    scope = f"task-claim:{student_id}:{task_code}"
    cached = idempotent_response(user_id, scope, idempotency_key, db)
    if cached is not None:
        return cached
    if task_code not in TASK_RULES or not TASK_RULES[task_code]["manual"]:
        raise GameConflict("TASK_NOT_CLAIMABLE", "该任务不可手动领取")
    local_today = china_now().date()
    task = get_or_create_task(student_id, local_today, task_code, db)
    if task.status == "claimed":
        raise GameConflict("TASK_ALREADY_CLAIMED", "任务已经领取")
    if task.status != "claimable":
        raise GameConflict("TASK_NOT_CLAIMABLE", "任务尚未达成")
    auto_grant_task(student_id, local_today, task_code, db)
    result = garden_state(student_id, db)
    save_idempotent_response(user_id, scope, idempotency_key, result, db)
    return result


def perform_action(
    student_id: str,
    action: str,
    quantity: int,
    idempotency_key: str,
    user_id: str,
    db: Session,
) -> dict:
    scope = f"garden-action:{student_id}"
    cached = idempotent_response(user_id, scope, idempotency_key, db)
    if cached is not None:
        return cached
    if action == "recover_tree" and quantity != 1:
        raise GameConflict("INVALID_QUANTITY", "恢复小树操作数量必须为 1")
    account = get_or_create_account(student_id, db)
    if action == "recover_tree":
        if not account.recovery_needed:
            raise GameConflict("RECOVERY_NOT_NEEDED", "当前不需要恢复小树")
        session = active_student_session(student_id, db)
        if session is None or session.current_posture != "normal" or session.abnormal_episode_id:
            raise GameConflict("POSTURE_STILL_ABNORMAL", "当前坐姿尚未稳定恢复正常")
    rule = ACTION_RULES[action]
    apply_ledger(
        account,
        db,
        business_key=f"action:{user_id}:{idempotency_key}",
        source_type="resource_action",
        source_id=action,
        growth_delta=rule["growth"] * quantity,
        sunshine_delta=rule["sunshine"] * quantity,
        water_delta=rule["water"] * quantity,
        nutrient_delta=rule["nutrient"] * quantity,
    )
    if action == "recover_tree":
        account.recovery_needed = False
    result = garden_state(student_id, db)
    save_idempotent_response(user_id, scope, idempotency_key, result, db)
    return result


def idempotent_response(user_id: str, scope: str, key: str, db: Session) -> dict | None:
    record = db.scalar(
        select(IdempotencyRecord).where(
            IdempotencyRecord.user_id == user_id,
            IdempotencyRecord.scope == scope,
            IdempotencyRecord.idempotency_key == key,
        )
    )
    return json.loads(record.response_json) if record else None


def save_idempotent_response(user_id: str, scope: str, key: str, response: dict, db: Session) -> None:
    db.add(
        IdempotencyRecord(
            user_id=user_id,
            scope=scope,
            idempotency_key=key,
            response_json=json.dumps(response, ensure_ascii=False),
        )
    )


def active_student_session(student_id: str, db: Session) -> DeviceSessionState | None:
    return db.scalar(
        select(DeviceSessionState)
        .where(DeviceSessionState.student_id == student_id, DeviceSessionState.status == "active")
        .order_by(DeviceSessionState.last_received_at.desc())
    )


def settle_due_growth(db: Session, now: datetime | None = None, catch_up: bool = False) -> list[dict]:
    now = now or utc_now()
    local_now = now.astimezone(CHINA_TZ)
    results = []
    progresses = list(db.scalars(select(GameDailyProgress).order_by(GameDailyProgress.local_date)))
    for progress in progresses:
        due = (
            progress.local_date <= local_now.date() and local_now.time() >= time(20, 0)
        ) or (
            catch_up
            and progress.local_date < local_now.date()
            and progress.last_settlement_date is None
        )
        if not due or progress.last_settlement_date == local_now.date():
            continue
        normal_s = max(0, progress.normal_s - progress.settled_normal_s)
        effective_s = max(0, progress.effective_measurement_s - progress.settled_effective_s)
        reminders = max(0, progress.reminder_count - progress.settled_reminder_count)
        if normal_s or effective_s or reminders:
            results.append(settle_progress_segment(progress, normal_s, effective_s, reminders, db, local_now.date()))
        progress.last_settlement_date = local_now.date()
    return results


def settle_progress_segment(
    progress: GameDailyProgress,
    normal_s: int,
    effective_s: int,
    reminders: int,
    db: Session,
    settlement_date: date,
) -> dict:
    rate = reminders * 1800 / max(effective_s, 1800)
    factor = 1.0 if rate < 3 else 0.9 if rate < 5 else 0.8
    calculated = math.floor(normal_s / 60)
    before_cap = math.floor(calculated * factor)
    remaining = max(0, DAILY_GROWTH_CAP - progress.growth_granted)
    granted = min(before_cap, remaining)
    business_key = f"growth:{progress.student_id}:{progress.local_date}:{settlement_date}"
    account = get_or_create_account(progress.student_id, db)
    apply_ledger(
        account,
        db,
        business_key=business_key,
        source_type="daily_growth",
        source_id=progress.local_date.isoformat(),
        growth_delta=granted,
    )
    segment = GrowthSettlementSegment(
        settlement_id=f"GST-{uuid4().hex[:20].upper()}",
        student_id=progress.student_id,
        local_date=progress.local_date,
        business_key=business_key,
        normal_s=normal_s,
        effective_measurement_s=effective_s,
        reminder_count=reminders,
        calculated_growth=calculated,
        reminder_rate_30m=rate,
        performance_factor=factor,
        growth_before_cap=before_cap,
        granted_growth=granted,
        rule_version=RULE_VERSION,
    )
    db.add(segment)
    progress.settled_normal_s += normal_s
    progress.settled_effective_s += effective_s
    progress.settled_reminder_count += reminders
    progress.growth_granted += granted
    return settlement_to_dict(segment, remaining - granted)


def settlement_to_dict(segment: GrowthSettlementSegment, remaining: int) -> dict:
    return {
        "student_id": segment.student_id,
        "local_date": segment.local_date.isoformat(),
        "calculated_growth": segment.calculated_growth,
        "reminder_rate_30m": round(segment.reminder_rate_30m, 1),
        "performance_factor": segment.performance_factor,
        "growth_before_cap": segment.growth_before_cap,
        "granted_growth": segment.granted_growth,
        "daily_growth_remaining": max(0, remaining),
    }


def settle_previous_daily_tasks(db: Session, now: datetime | None = None) -> None:
    now = now or utc_now()
    today = now.astimezone(CHINA_TZ).date()
    progresses = db.scalars(select(GameDailyProgress).where(GameDailyProgress.local_date < today))
    for progress in progresses:
        task = get_or_create_task(progress.student_id, progress.local_date, "daily_reminder_lt_5", db)
        task.progress_value = progress.effective_measurement_s
        if task.status != "claimed" and progress.effective_measurement_s >= 1800 and progress.reminder_count < 5:
            auto_grant_task(progress.student_id, progress.local_date, "daily_reminder_lt_5", db)


def expire_offline_sessions(db: Session, now: datetime | None = None) -> list[dict]:
    now = now or utc_now()
    events = []
    sessions = db.scalars(select(DeviceSessionState).where(DeviceSessionState.status == "active"))
    for session in sessions:
        age_s = max(0, int((now - as_utc(session.last_received_at)).total_seconds()))
        if age_s >= OFFLINE_DISPLAY_S:
            device = db.scalar(select(Device).where(Device.device_id == session.device_id))
            if device is not None and device.online_status != "offline":
                device.online_status = "offline"
                events.append(
                    {
                        "student_id": session.student_id,
                        "event": "device.offline",
                        "data": {"device_id": session.device_id},
                    }
                )
        if age_s >= OFFLINE_END_S:
            end_session(session, "offline_timeout", now, db)
    return events


def as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def game_rules() -> dict:
    return {
        "rule_version": RULE_VERSION,
        "postures": ["normal", "left_lean", "right_lean", "front_lean", "back_lean", "empty", "unknown"],
        "stages": [
            {"code": "seed", "min_growth": 0, "max_growth": 99},
            {"code": "sprout", "min_growth": 100, "max_growth": 299},
            {"code": "sapling", "min_growth": 300, "max_growth": 599},
            {"code": "tree", "min_growth": 600, "max_growth": 999},
            {"code": "flower", "min_growth": 1000, "max_growth": 1499},
            {"code": "fruit", "min_growth": 1500, "max_growth": None},
        ],
        "continuous_milestones": [
            {"minute": minute, "sunshine": reward[0], "water": reward[1], "nutrient": reward[2]}
            for minute, reward in MILESTONE_REWARDS.items()
        ],
        "actions": ACTION_RULES,
        "thresholds": {
            "abnormal_reminder_s": 30,
            "continuous_reset_s": 60,
            "normal_recovery_s": 5,
            "offline_display_s": OFFLINE_DISPLAY_S,
            "offline_end_s": OFFLINE_END_S,
            "empty_end_s": EMPTY_END_S,
            "growth_settlement_local_time": "20:00",
            "daily_growth_cap": DAILY_GROWTH_CAP,
        },
        "focus_mode_backend_enabled": False,
        "exercise_backend_enabled": False,
    }


def ledger_items(student_id: str, db: Session, cursor: int | None, limit: int) -> list[dict]:
    stmt = select(RewardLedger).where(RewardLedger.student_id == student_id)
    if cursor is not None:
        stmt = stmt.where(RewardLedger.id < cursor)
    rows = list(db.scalars(stmt.order_by(RewardLedger.id.desc()).limit(limit)))
    return [
        {
            "cursor": row.id,
            "ledger_id": row.ledger_id,
            "source_type": row.source_type,
            "source_id": row.source_id,
            "growth_delta": row.growth_delta,
            "sunshine_delta": row.sunshine_delta,
            "water_delta": row.water_delta,
            "nutrient_delta": row.nutrient_delta,
            "balance_after": json.loads(row.balance_after_json),
            "rule_version": row.rule_version,
            "created_at": row.created_at.isoformat(),
        }
        for row in rows
    ]
