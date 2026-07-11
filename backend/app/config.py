import os
from pathlib import Path

API_PREFIX = "/api/v1"
APP_VERSION = "0.1.0"
DEVICE_TOKEN = os.getenv("SPINEGUARD_DEVICE_TOKEN", "dev-token")
PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_SQLITE_PATH = PROJECT_ROOT / "backend" / "spineguard.db"
DATABASE_URL = os.getenv("DATABASE_URL", f"sqlite:///{DEFAULT_SQLITE_PATH.as_posix()}")
