from collections.abc import Generator

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import DATABASE_URL

connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}
engine = create_engine(DATABASE_URL, connect_args=connect_args)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


class Base(DeclarativeBase):
    pass


def init_db() -> None:
    from . import models  # noqa: F401

    Base.metadata.create_all(bind=engine)
    ensure_sqlite_columns()


def ensure_sqlite_columns() -> None:
    if not DATABASE_URL.startswith("sqlite"):
        return
    required_columns = {
        "devices": {
            "device_name": "VARCHAR(64) NOT NULL DEFAULT 'SpineGuard'",
            "claim_code_hash": "VARCHAR(255)",
            "config_version": "INTEGER NOT NULL DEFAULT 0",
            "vibration_enabled": "BOOLEAN NOT NULL DEFAULT 1",
            "reminder_mode": "VARCHAR(32) NOT NULL DEFAULT 'normal'",
            "reminder_trigger_duration_s": "INTEGER NOT NULL DEFAULT 300",
            "reminder_vibration_duration_s": "INTEGER NOT NULL DEFAULT 30",
            "reminder_cooldown_s": "INTEGER NOT NULL DEFAULT 600",
            "reminder_intensity_percent": "INTEGER NOT NULL DEFAULT 70",
            "applied_config_version": "INTEGER",
            "power_source": "VARCHAR(32)",
            "wifi_rssi_dbm": "INTEGER",
            "sensor_status_json": "TEXT",
        },
        "posture_records": {
            "raw_pressure_left": "INTEGER",
            "raw_pressure_right": "INTEGER",
            "raw_pressure_front": "INTEGER",
            "raw_pressure_back": "INTEGER",
            "raw_pressure_center": "INTEGER",
            "device_name": "VARCHAR(64)",
            "occupied": "BOOLEAN",
            "ratio_valid": "BOOLEAN",
            "backrest_online": "BOOLEAN",
            "backrest_data_ready": "BOOLEAN",
            "backrest_valid": "BOOLEAN",
            "backrest_distance_mm": "FLOAT",
            "backrest_range_status": "INTEGER",
            "vibration_effective_enabled": "BOOLEAN",
            "reminder_due": "BOOLEAN",
            "reminder_suppressed": "BOOLEAN",
            "vibration_active": "BOOLEAN",
            "vibration_position": "VARCHAR(16)",
            "reminder_cooldown_remaining_s": "INTEGER",
            "applied_config_version": "INTEGER",
            "reminder_config_json": "TEXT",
            "power_source": "VARCHAR(32)",
            "wifi_rssi_dbm": "INTEGER",
            "sensor_status_json": "TEXT",
            "command_status_json": "TEXT",
            "device_credential_mode": "VARCHAR(32)",
        },
    }
    with engine.begin() as connection:
        for table_name, columns in required_columns.items():
            existing = {column["name"] for column in inspect(engine).get_columns(table_name)}
            for name, sql_type in columns.items():
                if name not in existing:
                    connection.execute(text(f"ALTER TABLE {table_name} ADD COLUMN {name} {sql_type}"))


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
