import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
BACKEND_DIR = PROJECT_ROOT / "backend"


def load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


load_env_file(BACKEND_DIR / ".env")

API_PREFIX = "/api/v1"
APP_VERSION = "0.1.0"
DEVICE_TOKEN = os.getenv("SPINEGUARD_DEVICE_TOKEN", "dev-token")
SECRET_KEY = os.getenv("SPINEGUARD_SECRET_KEY", "dev-secret-change-me")
ACCESS_TOKEN_EXPIRE_MINUTES = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", "1440"))
LLM_API_KEY = os.getenv("LLM_API_KEY", "")
LLM_API_BASE = os.getenv("LLM_API_BASE", "")
LLM_MODEL = os.getenv("LLM_MODEL", "placeholder-model")
LLM_TIMEOUT_SECONDS = float(os.getenv("LLM_TIMEOUT_SECONDS", "60"))
LLM_MAX_TOKENS = max(1, int(os.getenv("LLM_MAX_TOKENS", "1200")))
LLM_ENABLE_THINKING = os.getenv("LLM_ENABLE_THINKING", "false").lower() in {"1", "true", "yes", "on"}
AUTO_REPORT_ENABLED = os.getenv("AUTO_REPORT_ENABLED", "true").lower() in {"1", "true", "yes", "on"}
AUTO_REPORT_USE_LLM = os.getenv("AUTO_REPORT_USE_LLM", "true").lower() in {"1", "true", "yes", "on"}
AUTO_REPORT_CATCH_UP_DAYS = max(1, int(os.getenv("AUTO_REPORT_CATCH_UP_DAYS", "7")))
DEFAULT_SQLITE_PATH = BACKEND_DIR / "spineguard.db"
DATABASE_URL = os.getenv("DATABASE_URL", f"sqlite:///{DEFAULT_SQLITE_PATH.as_posix()}")
