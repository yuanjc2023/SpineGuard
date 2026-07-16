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
    ensure_sqlite_posture_record_columns()


def ensure_sqlite_posture_record_columns() -> None:
    if not DATABASE_URL.startswith("sqlite"):
        return
    required_columns = {
        "raw_pressure_left": "INTEGER",
        "raw_pressure_right": "INTEGER",
        "raw_pressure_front": "INTEGER",
        "raw_pressure_back": "INTEGER",
        "raw_pressure_center": "INTEGER",
    }
    existing = {column["name"] for column in inspect(engine).get_columns("posture_records")}
    with engine.begin() as connection:
        for name, sql_type in required_columns.items():
            if name not in existing:
                connection.execute(text(f"ALTER TABLE posture_records ADD COLUMN {name} {sql_type}"))


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
