import json
from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import DailyStat, RiskAssessment
from .stats import calculate_daily_stat


def assess_risk(student_id: str, end_date: date, db: Session) -> RiskAssessment:
    period_start = end_date - timedelta(days=6)
    stats = [calculate_daily_stat(student_id, period_start + timedelta(days=i), db) for i in range(7)]
    active_stats = [s for s in stats if s.total_sitting_s > 0]

    poor_sitting_s = sum(s.poor_sitting_s for s in active_stats)
    total_sitting_s = sum(s.total_sitting_s for s in active_stats)
    avg_asymmetry = (
        sum(s.avg_asymmetry_index for s in active_stats) / len(active_stats)
        if active_stats else 0.0
    )
    max_poor_duration = max((s.max_poor_posture_duration_s for s in active_stats), default=0)
    reminder_count = sum(s.reminder_count for s in active_stats)
    poor_ratio = poor_sitting_s / total_sitting_s if total_sitting_s else 0.0

    score = 0
    reasons: list[str] = []
    if poor_ratio >= 0.45:
        score += 35
        reasons.append("近 7 天非标准坐姿占比较高")
    elif poor_ratio >= 0.25:
        score += 20
        reasons.append("近 7 天存在一定非标准坐姿占比")

    if avg_asymmetry >= 0.35:
        score += 30
        reasons.append("近 7 天压力不对称指数偏高")
    elif avg_asymmetry >= 0.2:
        score += 15
        reasons.append("近 7 天压力不对称指数略高")

    if max_poor_duration >= 300:
        score += 25
        reasons.append("单次非标准坐姿持续时间较长")
    elif max_poor_duration >= 120:
        score += 10
        reasons.append("存在连续非标准坐姿持续情况")

    if reminder_count >= 10:
        score += 10
        reasons.append("提醒次数较多")

    score = min(score, 100)
    if score >= 70:
        level = "red"
        suggestion = "坐姿行为风险较高，建议加强日常坐姿干预，并作为进一步筛查参考。"
    elif score >= 35:
        level = "yellow"
        suggestion = "存在一定坐姿行为风险，建议关注坐姿习惯并增加休息和纠正提醒。"
    else:
        level = "green"
        suggestion = "坐姿行为风险较低，建议继续保持良好坐姿习惯。"

    if not reasons:
        reasons.append("近 7 天未发现明显持续异常坐姿行为")

    assessment = db.scalar(
        select(RiskAssessment).where(
            RiskAssessment.student_id == student_id,
            RiskAssessment.period_start == period_start,
            RiskAssessment.period_end == end_date,
        )
    )
    if assessment is None:
        assessment = RiskAssessment(student_id=student_id, period_start=period_start, period_end=end_date)
        db.add(assessment)

    assessment.risk_level = level
    assessment.risk_score = score
    assessment.risk_reasons = json.dumps(reasons, ensure_ascii=False)
    assessment.suggestion = suggestion
    db.commit()
    db.refresh(assessment)
    return assessment


def risk_to_dict(assessment: RiskAssessment) -> dict:
    return {
        "student_id": assessment.student_id,
        "period_start": assessment.period_start.isoformat(),
        "period_end": assessment.period_end.isoformat(),
        "risk_level": assessment.risk_level,
        "risk_score": assessment.risk_score,
        "risk_reasons": json.loads(assessment.risk_reasons),
        "suggestion": assessment.suggestion,
    }

