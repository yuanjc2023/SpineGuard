from fastapi.middleware.cors import CORSMiddleware

from fastapi import FastAPI

from .db import init_db
from .config import APP_VERSION
from .routes.health import router as health_router
from .routes.telemetry import router as telemetry_router


app = FastAPI(title="SpineGuard API", version=APP_VERSION)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(health_router)
app.include_router(telemetry_router)


@app.on_event("startup")
def on_startup():
    init_db()
