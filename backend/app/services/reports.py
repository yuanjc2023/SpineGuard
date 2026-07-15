import json
from urllib import request
from urllib.error import HTTPError, URLError
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import LLM_API_BASE, LLM_API_KEY, LLM_MODEL, LLM_TIMEOUT_SECONDS
from ..models import Report
from .report_analytics import CHINA_TZ, latest_records, period_records, summarize_records
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
    records = period_records(student_id, period_start, end_date, db)
    analytics, _ = summarize_records(records)
    risk = assess_risk(student_id, end_date, db, commit=commit)
    summary = {
        "student_id": student_id,
        "report_type": report_type,
        "data_scope": "natural_period",
        "period_start": period_start.isoformat(),
        "period_end": end_date.isoformat(),
        **analytics,
        "total_sitting_s": analytics["effective_sitting_s"],
        "risk": risk_to_dict(risk),
    }
    content = generate_llm_report(summary, report_mode="scheduled") if use_llm else rule_report_content(summary)
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


def generate_latest_smart_report(
    student_id: str,
    record_limit: int,
    db: Session,
) -> Report:
    records = latest_records(student_id, record_limit, db)
    if not records:
        raise ValueError("No posture records available")
    analytics, compact_records = summarize_records(records)
    start_date = datetime.fromtimestamp(records[0].timestamp_ms / 1000, timezone.utc).astimezone(CHINA_TZ).date()
    end_date = datetime.fromtimestamp(records[-1].timestamp_ms / 1000, timezone.utc).astimezone(CHINA_TZ).date()
    summary = {
        "student_id": student_id,
        "report_type": "smart",
        "data_scope": "latest_records",
        "requested_record_limit": record_limit,
        "period_start": start_date.isoformat(),
        "period_end": end_date.isoformat(),
        **analytics,
        "total_sitting_s": analytics["effective_sitting_s"],
    }
    llm_payload = {
        "summary": summary,
        "compact_record_fields": {
            "t": "timestamp_ms",
            "p": "posture",
            "d": "confirmed_duration_s",
            "a": "asymmetry_index",
            "tx": "tilt_x",
            "ty": "tilt_y",
            "r": "device_cumulative_reminder_count",
        },
        "records": compact_records,
    }
    content = generate_llm_report(
        llm_payload,
        report_mode="latest_records",
        fallback_summary=summary,
    )
    generated_by = "llm_fallback" if content.startswith("【LLM 调用未完成】") else "llm"
    report = Report(
        student_id=student_id,
        report_type="smart",
        period_start=start_date,
        period_end=end_date,
        summary_json=json.dumps(summary, ensure_ascii=False),
        content=content,
        generated_by=generated_by,
    )
    db.add(report)
    db.commit()
    db.refresh(report)
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
        "report_id": report.id,
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
    posture_stats = summary.get("posture_stats", {})
    normal = posture_stats.get("normal", {"duration_s": 0, "ratio": 0})
    abnormal_text = "；".join(
        f"{posture} {posture_stats.get(posture, {}).get('duration_s', 0)} 秒，"
        f"占比 {posture_stats.get(posture, {}).get('ratio', 0):.1%}"
        for posture in ("left_lean", "right_lean", "front_lean", "back_lean")
    )
    risk = summary.get("risk")
    suggestion = risk["suggestion"] if risk else "建议保持规律休息，并关注持续非标准坐姿。"
    risk_text = (
        f"当前坐姿行为风险提示为 {risk['risk_level']}。"
        if risk else "本报告仅作为坐姿行为筛查参考。"
    )
    return (
        f"本周期标准坐姿 {normal['duration_s']} 秒，占比 {normal['ratio']:.1%}。"
        f"非标准姿态：{abnormal_text}。总提醒 {summary.get('reminder_count', 0)} 次，"
        f"最长连续异常 {summary.get('max_continuous_abnormal_s', 0)} 秒。"
        f"姿态变化趋势：{summary.get('trend', {}).get('description', '暂无法判断')}"
        f"{risk_text}建议：{suggestion}"
    )


def generate_llm_report(
    summary: dict,
    report_mode: str = "scheduled",
    fallback_summary: dict | None = None,
) -> str:
    fallback_data = fallback_summary or summary
    if not llm_configured():
        return llm_fallback(fallback_data, "LLM_API_KEY、LLM_API_BASE 或 LLM_MODEL 尚未正确配置")

    requirements = (
        "请严格依据后端给出的统计值生成一份最近记录智能报告，必须包含："
        "1.标准坐姿时长和比例；2.左倾、右倾、前倾、后倾各自的时长和比例；"
        "3.提醒次数；4.最长连续异常时间；5.姿态变化趋势；6.可执行的日常建议。"
        "不得修改统计数值，不得把 empty 或 unknown 算作有效坐姿，不得给出医学诊断。"
        if report_mode == "latest_records" else
        "请严格依据后端给出的自然周期统计生成日报、周报或月报，必须包含："
        "1.标准坐姿时长和比例；2.左倾、右倾、前倾、后倾各自的时长和比例；"
        "3.总提醒次数；4.提醒次数最多的日期及次数；"
        "5.姿态趋势是改善、变差、稳定或数据不足；6.可执行的日常建议。"
        "不得修改统计数值，不得给出医学诊断。"
    )
    payload = {
        "model": LLM_MODEL,
        "messages": [
            {
                "role": "system",
                "content": (
                    "你是 SpineGuard 青少年坐姿行为报告助手。"
                    "只能给出坐姿行为风险提示、筛查参考和日常纠正建议，不能做医学诊断。"
                    "不要编造学生姓名、手机号、真实班级或医疗结论。"
                    "所有统计数字必须原样使用后端提供的结果，不得重新估算或虚构。"
                ),
            },
            {
                "role": "user",
                "content": (
                    f"{requirements}\n"
                    "请使用清晰的小标题和简洁中文；建议应是日常行为建议，风险结果只能作为筛查参考。\n"
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
        return llm_fallback(fallback_data, f"真实 LLM API 调用失败：{exc.__class__.__name__}")

    content = extract_llm_content(data)
    if not content:
        return llm_fallback(fallback_data, "真实 LLM API 返回内容为空或格式不兼容")
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
