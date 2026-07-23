import csv
from datetime import datetime, timezone
from io import BytesIO, StringIO
from zipfile import ZIP_DEFLATED, ZipFile
from xml.sax.saxutils import escape

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import API_PREFIX
from ..db import get_db
from ..models import DailyStat, Device, DeviceBinding, PostureRecord, RiskAssessment, Student, User
from ..services.auth import require_roles
from ..services.telemetry import parse_time_filter

router = APIRouter(prefix=f"{API_PREFIX}/admin", tags=["admin"])


@router.get("/overview")
def overview(
    _: User = Depends(require_roles("school_admin", "admin")),
    db: Session = Depends(get_db),
):
    students = list(db.scalars(select(Student)))
    devices = list(db.scalars(select(Device)))
    daily_stats = list(db.scalars(select(DailyStat)))
    red_student_ids = {
        assessment.student_id
        for assessment in db.scalars(select(RiskAssessment).where(RiskAssessment.risk_level == "red"))
    }

    class_summaries = []
    for class_id in sorted({student.class_id or "unassigned" for student in students}):
        class_students = [student for student in students if (student.class_id or "unassigned") == class_id]
        class_student_ids = {student.student_id for student in class_students}
        class_stats = [stat for stat in daily_stats if stat.student_id in class_student_ids]
        class_summaries.append(
            {
                "class_id": class_id,
                "student_count": len(class_students),
                "average_normal_ratio": average_normal_ratio(class_stats),
                "high_risk_student_count": len(class_student_ids & red_student_ids),
            }
        )

    return {
        "ok": True,
        "data": {
            "student_count": len(students),
            "device_count": len(devices),
            "active_device_count": len([device for device in devices if device.online_status == "online"]),
            "average_normal_ratio": average_normal_ratio(daily_stats),
            "high_risk_student_count": len(red_student_ids),
            "class_summaries": class_summaries,
        },
    }


@router.get("/classes")
def list_classes(
    _: User = Depends(require_roles("school_admin", "admin")),
    db: Session = Depends(get_db),
):
    students = list(db.scalars(select(Student)))
    devices = list(db.scalars(select(Device)))
    daily_stats = list(db.scalars(select(DailyStat)))
    red_student_ids = high_risk_student_ids(db)

    items = []
    for class_id in sorted({student.class_id or "unassigned" for student in students}):
        class_students = [student for student in students if (student.class_id or "unassigned") == class_id]
        class_student_ids = {student.student_id for student in class_students}
        class_stats = [stat for stat in daily_stats if stat.student_id in class_student_ids]
        bound_devices = devices_for_students(class_student_ids, devices, db)
        items.append(
            {
                "class_id": class_id,
                "student_count": len(class_students),
                "device_count": len(bound_devices),
                "online_device_count": len([device for device in bound_devices if device.online_status == "online"]),
                "average_normal_ratio": average_normal_ratio(class_stats),
                "high_risk_student_count": len(class_student_ids & red_student_ids),
            }
        )
    return {"ok": True, "items": items, "total": len(items)}


@router.get("/classes/{class_id}/students")
def class_students(
    class_id: str,
    _: User = Depends(require_roles("school_admin", "admin")),
    db: Session = Depends(get_db),
):
    student_class_id = None if class_id == "unassigned" else class_id
    students = list(db.scalars(select(Student).where(Student.class_id == student_class_id).order_by(Student.student_id)))
    daily_stats = list(db.scalars(select(DailyStat)))
    latest_risks = latest_risk_by_student(db)

    items = []
    for student in students:
        stats = [stat for stat in daily_stats if stat.student_id == student.student_id]
        risk = latest_risks.get(student.student_id)
        items.append(
            {
                "student_id": student.student_id,
                "display_code": student.display_code,
                "school_id": student.school_id,
                "class_id": student.class_id,
                "average_normal_ratio": average_normal_ratio(stats),
                "total_sitting_s": sum(stat.total_sitting_s for stat in stats),
                "reminder_count": sum(stat.reminder_count for stat in stats),
                "risk_level": risk.risk_level if risk else "unknown",
                "risk_score": risk.risk_score if risk else 0,
            }
        )

    return {"ok": True, "items": items, "total": len(items)}


@router.get("/risk-students")
def risk_students(
    risk_level: str = Query("red"),
    _: User = Depends(require_roles("school_admin", "admin", "doctor")),
    db: Session = Depends(get_db),
):
    if risk_level not in ("green", "yellow", "red", "all"):
        raise HTTPException(status_code=400, detail="risk_level must be green, yellow, red, or all")

    students = {student.student_id: student for student in db.scalars(select(Student))}
    latest_risks = latest_risk_by_student(db)
    items = []
    for student_id, risk in latest_risks.items():
        if risk_level != "all" and risk.risk_level != risk_level:
            continue
        student = students.get(student_id)
        if student is None:
            continue
        items.append(
            {
                "student_id": student.student_id,
                "display_code": student.display_code,
                "school_id": student.school_id,
                "class_id": student.class_id,
                "risk_level": risk.risk_level,
                "risk_score": risk.risk_score,
                "period_start": risk.period_start.isoformat(),
                "period_end": risk.period_end.isoformat(),
                "suggestion": risk.suggestion,
            }
        )

    items.sort(key=lambda item: item["risk_score"], reverse=True)
    return {"ok": True, "items": items, "total": len(items)}


@router.get("/risk-students/export")
def export_risk_student_records(
    risk_level: str = Query("red"),
    from_value: str | None = Query(default=None, alias="from"),
    to_value: str | None = Query(default=None, alias="to"),
    _: User = Depends(require_roles("school_admin", "admin", "doctor")),
    db: Session = Depends(get_db),
):
    if risk_level not in ("green", "yellow", "red", "all"):
        raise HTTPException(status_code=400, detail="risk_level must be green, yellow, red, or all")

    try:
        start_ms = parse_time_filter(from_value, end_of_day=False)
        end_ms = parse_time_filter(to_value, end_of_day=True)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    student_ids = risk_student_ids(risk_level, db)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    buffer = BytesIO()
    with ZipFile(buffer, "w", ZIP_DEFLATED) as zip_file:
        for student_id in sorted(student_ids):
            records = abnormal_records_for_student(student_id, start_ms, end_ms, db)
            if not records:
                continue
            rows = [record_export_row(record) for record in records]
            safe_student_id = safe_filename_part(student_id)
            zip_file.writestr(
                f"{safe_student_id}_{timestamp}.xlsx",
                build_xlsx(export_fieldnames(), rows),
            )

    return Response(
        content=buffer.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="risk-students-{timestamp}.zip"'},
    )


@router.get("/export")
def export_records(
    from_value: str | None = Query(default=None, alias="from"),
    to_value: str | None = Query(default=None, alias="to"),
    format_value: str = Query(default="csv", alias="format"),
    _: User = Depends(require_roles("school_admin", "admin")),
    db: Session = Depends(get_db),
):
    if format_value not in ("csv", "xlsx"):
        raise HTTPException(status_code=400, detail="Only csv and xlsx export are supported now")

    try:
        start_ms = parse_time_filter(from_value, end_of_day=False)
        end_ms = parse_time_filter(to_value, end_of_day=True)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    stmt = select(PostureRecord)
    if start_ms is not None:
        stmt = stmt.where(PostureRecord.timestamp_ms >= start_ms)
    if end_ms is not None:
        stmt = stmt.where(PostureRecord.timestamp_ms <= end_ms)
    records = list(db.scalars(stmt.order_by(PostureRecord.timestamp_ms, PostureRecord.id)))

    rows = [record_export_row(record) for record in records]
    if format_value == "xlsx":
        return Response(
            content=build_xlsx(export_fieldnames(), rows),
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": 'attachment; filename="spineguard-posture-records.xlsx"'},
        )

    output = StringIO()
    writer = csv.DictWriter(output, fieldnames=export_fieldnames())
    writer.writeheader()
    for row in rows:
        writer.writerow(row)
    return Response(
        content=output.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="spineguard-posture-records.csv"'},
    )


def average_normal_ratio(stats: list[DailyStat]) -> float:
    if not stats:
        return 0.0
    return round(sum(stat.normal_ratio for stat in stats) / len(stats), 4)


def high_risk_student_ids(db: Session) -> set[str]:
    return {
        assessment.student_id
        for assessment in db.scalars(select(RiskAssessment).where(RiskAssessment.risk_level == "red"))
    }


def latest_risk_by_student(db: Session) -> dict[str, RiskAssessment]:
    risks: dict[str, RiskAssessment] = {}
    assessments = db.scalars(select(RiskAssessment).order_by(RiskAssessment.period_end, RiskAssessment.id))
    for assessment in assessments:
        risks[assessment.student_id] = assessment
    return risks


def risk_student_ids(risk_level: str, db: Session) -> set[str]:
    latest_risks = latest_risk_by_student(db)
    return {
        student_id
        for student_id, risk in latest_risks.items()
        if risk_level == "all" or risk.risk_level == risk_level
    }


def abnormal_records_for_student(
    student_id: str,
    start_ms: int | None,
    end_ms: int | None,
    db: Session,
) -> list[PostureRecord]:
    stmt = select(PostureRecord).where(
        PostureRecord.student_id == student_id,
        PostureRecord.posture != "normal",
        PostureRecord.posture != "empty",
    )
    if start_ms is not None:
        stmt = stmt.where(PostureRecord.timestamp_ms >= start_ms)
    if end_ms is not None:
        stmt = stmt.where(PostureRecord.timestamp_ms <= end_ms)
    return list(db.scalars(stmt.order_by(PostureRecord.timestamp_ms, PostureRecord.id)))


def safe_filename_part(value: str) -> str:
    return "".join(char if char.isalnum() or char in ("-", "_") else "_" for char in value)[:80]


def devices_for_students(student_ids: set[str], devices: list[Device], db: Session) -> list[Device]:
    if not student_ids:
        return []
    device_ids = set(
        db.scalars(
            select(DeviceBinding.device_id)
            .where(
                DeviceBinding.student_id.in_(student_ids),
                DeviceBinding.active.is_(True),
            )
            .distinct()
        )
    )
    device_by_id = {device.device_id: device for device in devices}
    return [device_by_id[device_id] for device_id in device_ids if device_id in device_by_id]


def export_fieldnames() -> list[str]:
    return [
        "student_id",
        "device_id",
        "session_id",
        "seq",
        "timestamp_ms",
        "posture",
        "confidence",
        "pressure_left",
        "pressure_right",
        "pressure_front",
        "pressure_back",
        "pressure_center",
        "raw_pressure_left",
        "raw_pressure_right",
        "raw_pressure_front",
        "raw_pressure_back",
        "raw_pressure_center",
        "occupied",
        "ratio_valid",
        "backrest_online",
        "backrest_valid",
        "backrest_distance_mm",
        "backrest_range_status",
        "total_pressure",
        "left_right_diff",
        "front_back_diff",
        "center_x",
        "center_y",
        "asymmetry_index",
        "tilt_x",
        "tilt_y",
        "shake_level",
        "posture_duration_s",
        "sitting_duration_s",
        "warning_active",
        "vibration_active",
        "vibration_position",
        "reminder_count",
        "battery_level",
        "recognition_source",
        "model_version",
        "firmware_version",
    ]


def record_export_row(record: PostureRecord) -> dict:
    return {
        "student_id": record.student_id or "",
        "device_id": record.device_id,
        "session_id": record.session_id,
        "seq": record.seq,
        "timestamp_ms": record.timestamp_ms,
        "posture": record.posture,
        "confidence": record.confidence,
        "pressure_left": record.pressure_left,
        "pressure_right": record.pressure_right,
        "pressure_front": record.pressure_front,
        "pressure_back": record.pressure_back,
        "pressure_center": record.pressure_center,
        "raw_pressure_left": record.raw_pressure_left,
        "raw_pressure_right": record.raw_pressure_right,
        "raw_pressure_front": record.raw_pressure_front,
        "raw_pressure_back": record.raw_pressure_back,
        "raw_pressure_center": record.raw_pressure_center,
        "occupied": record.occupied,
        "ratio_valid": record.ratio_valid,
        "backrest_online": record.backrest_online,
        "backrest_valid": record.backrest_valid,
        "backrest_distance_mm": record.backrest_distance_mm,
        "backrest_range_status": record.backrest_range_status,
        "total_pressure": record.total_pressure,
        "left_right_diff": record.left_right_diff,
        "front_back_diff": record.front_back_diff,
        "center_x": record.center_x,
        "center_y": record.center_y,
        "asymmetry_index": record.asymmetry_index,
        "tilt_x": record.tilt_x,
        "tilt_y": record.tilt_y,
        "shake_level": record.shake_level,
        "posture_duration_s": record.posture_duration_s,
        "sitting_duration_s": record.sitting_duration_s,
        "warning_active": record.warning_active,
        "vibration_active": record.vibration_active,
        "vibration_position": record.vibration_position,
        "reminder_count": record.reminder_count,
        "battery_level": record.battery_level,
        "recognition_source": record.recognition_source,
        "model_version": record.model_version,
        "firmware_version": record.firmware_version,
    }


def build_xlsx(headers: list[str], rows: list[dict]) -> bytes:
    buffer = BytesIO()
    now = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    with ZipFile(buffer, "w", ZIP_DEFLATED) as xlsx:
        xlsx.writestr("[Content_Types].xml", content_types_xml())
        xlsx.writestr("_rels/.rels", root_rels_xml())
        xlsx.writestr("docProps/core.xml", core_xml(now))
        xlsx.writestr("docProps/app.xml", app_xml())
        xlsx.writestr("xl/workbook.xml", workbook_xml())
        xlsx.writestr("xl/_rels/workbook.xml.rels", workbook_rels_xml())
        xlsx.writestr("xl/styles.xml", styles_xml())
        xlsx.writestr("xl/worksheets/sheet1.xml", sheet_xml(headers, rows))
    return buffer.getvalue()


def sheet_xml(headers: list[str], rows: list[dict]) -> str:
    xml_rows = [worksheet_row(1, headers, header=True)]
    for index, row in enumerate(rows, start=2):
        xml_rows.append(worksheet_row(index, [row.get(header, "") for header in headers]))
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        "<sheetData>"
        f"{''.join(xml_rows)}"
        "</sheetData>"
        "</worksheet>"
    )


def worksheet_row(row_index: int, values: list, header: bool = False) -> str:
    cells = []
    for column_index, value in enumerate(values, start=1):
        cell_ref = f"{excel_column(column_index)}{row_index}"
        style = ' s="1"' if header else ""
        if isinstance(value, bool):
            cells.append(f'<c r="{cell_ref}" t="b"{style}><v>{1 if value else 0}</v></c>')
        elif isinstance(value, (int, float)) and not isinstance(value, bool):
            cells.append(f'<c r="{cell_ref}"{style}><v>{value}</v></c>')
        else:
            cells.append(f'<c r="{cell_ref}" t="inlineStr"{style}><is><t>{escape(str(value))}</t></is></c>')
    return f'<row r="{row_index}">{"".join(cells)}</row>'


def excel_column(index: int) -> str:
    result = ""
    while index:
        index, remainder = divmod(index - 1, 26)
        result = chr(65 + remainder) + result
    return result


def content_types_xml() -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
        '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
        "</Types>"
    )


def root_rels_xml() -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
        '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>'
        "</Relationships>"
    )


def workbook_xml() -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        '<sheets><sheet name="posture_records" sheetId="1" r:id="rId1"/></sheets>'
        "</workbook>"
    )


def workbook_rels_xml() -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
        "</Relationships>"
    )


def styles_xml() -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
        '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>'
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
        '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0"/></cellXfs>'
        "</styleSheet>"
    )


def core_xml(now: str) -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
        'xmlns:dc="http://purl.org/dc/elements/1.1/" '
        'xmlns:dcterms="http://purl.org/dc/terms/" '
        'xmlns:dcmitype="http://purl.org/dc/dcmitype/" '
        'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
        "<dc:creator>SpineGuard</dc:creator>"
        f'<dcterms:created xsi:type="dcterms:W3CDTF">{now}</dcterms:created>'
        f'<dcterms:modified xsi:type="dcterms:W3CDTF">{now}</dcterms:modified>'
        "</cp:coreProperties>"
    )


def app_xml() -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" '
        'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
        "<Application>SpineGuard Backend</Application>"
        "</Properties>"
    )
