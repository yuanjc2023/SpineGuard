import json
from urllib import request
from urllib.error import HTTPError, URLError
from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import LLM_API_BASE, LLM_API_KEY, LLM_MODEL, LLM_TIMEOUT_SECONDS
from ..models import Report
from .risk import assess_risk, risk_to_dict
from .stats import calculate_daily_stat


def generate_report(
    student_id: str,
    report_type: str,
    end_date: date,
    use_llm: bool,
    db: Session,
    period_start: date | None = None,
    commit: bool = True,
) -> Report:
    period_start = period_start or period_start_for(report_type, end_date)
    daily_stats = []
    day = period_start
    while day <= end_date:
        daily_stats.append(calculate_daily_stat(student_id, day, db, commit=commit))
        day += timedelta(days=1)

    risk = assess_risk(student_id, end_date, db, commit=commit)
    summary = {
        "student_id": student_id,
        "report_type": report_type,
        "period_start": period_start.isoformat(),
        "period_end": end_date.isoformat(),
        "total_sitting_s": sum(s.total_sitting_s for s in daily_stats),
        "normal_sitting_s": sum(s.normal_sitting_s for s in daily_stats),
        "poor_sitting_s": sum(s.poor_sitting_s for s in daily_stats),
        "reminder_count": sum(s.reminder_count for s in daily_stats),
        "avg_asymmetry_index": round(
            sum(s.avg_asymmetry_index for s in daily_stats) / len(daily_stats),
            4,
        ) if daily_stats else 0.0,
        "risk": risk_to_dict(risk),
    }
    content = generate_llm_report(summary) if use_llm else rule_report_content(summary)
    generated_by = "llm" if use_llm and not content.startswith("【LLM 调用未完成】") else ("llm_fallback" if use_llm else "rule")

    report = Report(
        student_id=student_id,
        report_type=report_type,
        period_start=period_start,
        period_end=end_date,
        summary_json=json.dumps(summary, ensure_ascii=False),
        content=content,
        generated_by=generated_by,
    )
    db.add(report)
    if commit:
        db.commit()
        db.refresh(report)
    else:
        db.flush()
    return report


def list_reports(student_id: str, db: Session) -> list[Report]:
    return list(
        db.scalars(
            select(Report)
            .where(Report.student_id == student_id)
            .order_by(Report.created_at.desc(), Report.id.desc())
        )
    )


def report_to_dict(report: Report) -> dict:
    return {
        "student_id": report.student_id,
        "report_type": report.report_type,
        "period_start": report.period_start.isoformat(),
        "period_end": report.period_end.isoformat(),
        "summary": json.loads(report.summary_json),
        "content": report.content,
        "generated_by": report.generated_by,
        "created_at": report.created_at.isoformat(),
    }


def period_start_for(report_type: str, end_date: date) -> date:
    if report_type == "weekly":
        return end_date - timedelta(days=6)
    if report_type == "monthly":
        return end_date - timedelta(days=29)
    return end_date


def rule_report_content(summary: dict) -> str:
    risk = summary["risk"]
    return (
        f"本周期坐姿行为小结：标准坐姿约 {summary['normal_sitting_s']} 秒，"
        f"非标准坐姿约 {summary['poor_sitting_s']} 秒，提醒 {summary['reminder_count']} 次。"
        f"当前坐姿行为风险提示为 {risk['risk_level']}，主要原因：{'；'.join(risk['risk_reasons'])}。"
        f"{risk['suggestion']}"
    )


def generate_llm_report(summary: dict) -> str:
    if not llm_configured():
        return llm_fallback(summary, "LLM_API_KEY、LLM_API_BASE 或 LLM_MODEL 尚未正确配置")

    payload = {
        "model": LLM_MODEL,
        "messages": [
            {
                "role": "system",
                "content": (
                    "你是 SpineGuard 青少年坐姿行为报告助手。"
                    "只能给出坐姿行为风险提示、筛查参考和日常纠正建议，不能做医学诊断。"
                    "不要编造学生姓名、手机号、真实班级或医疗结论。"
                ),
            },
            {
                "role": "user",
                "content": (
                    "请基于以下匿名统计摘要生成一份简洁中文报告，包含："
                    "坐姿情况总结、风险解释、纠正建议、家长提醒、是否建议校医进一步筛查参考。\n"
                    f"{json.dumps(summary, ensure_ascii=False)}"
                ),
            },
        ],
        "temperature": 0.3,
    }

    try:
        req = request.Request(
            llm_chat_url(),
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {LLM_API_KEY}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        with request.urlopen(req, timeout=LLM_TIMEOUT_SECONDS) as response:
            data = json.loads(response.read().decode("utf-8"))
    except (HTTPError, URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
        return llm_fallback(summary, f"真实 LLM API 调用失败：{exc.__class__.__name__}")

    content = extract_llm_content(data)
    if not content:
        return llm_fallback(summary, "真实 LLM API 返回内容为空或格式不兼容")
    return content


def llm_configured() -> bool:
    return all(
        [
            LLM_API_KEY and "填入" not in LLM_API_KEY,
            LLM_API_BASE and "填入" not in LLM_API_BASE,
            LLM_MODEL and "填入" not in LLM_MODEL,
        ]
    )


def llm_chat_url() -> str:
    base = LLM_API_BASE.rstrip("/")
    if base.endswith("/chat/completions"):
        return base
    return f"{base}/chat/completions"


def extract_llm_content(data: dict) -> str:
    choices = data.get("choices") or []
    if not choices:
        return ""
    message = choices[0].get("message") or {}
    return str(message.get("content") or "").strip()


def llm_fallback(summary: dict, reason: str) -> str:
    return (
        f"【LLM 调用未完成】{reason}。"
        "已使用本地规则生成兜底内容。"
        "建议发送给模型的数据只包含匿名 student_id 和统计摘要，不包含学生姓名、手机号或真实班级信息。"
        f"{rule_report_content(summary)}"
    )
