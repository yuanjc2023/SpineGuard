import asyncio

from fastapi.middleware.cors import CORSMiddleware

from fastapi import FastAPI

from .db import init_db
from .config import APP_VERSION
from .routes.admin import router as admin_router
from .routes.auth import compat_router as auth_compat_router
from .routes.auth import router as auth_router
from .routes.devices import router as devices_router
from .routes.health import router as health_router
from .routes.game import router as game_router
from .routes.notifications import router as notifications_router
from .routes.students import router as students_router
from .routes.telemetry import router as telemetry_router
from .services.maintenance import maintenance_loop, stop_maintenance


app = FastAPI(title="SpineGuard API", version=APP_VERSION)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(health_router)
app.include_router(auth_router)
app.include_router(auth_compat_router)
app.include_router(students_router)
app.include_router(devices_router)
app.include_router(telemetry_router)
app.include_router(admin_router)
app.include_router(notifications_router)
app.include_router(game_router)

maintenance_task = None


@app.on_event("startup")
def on_startup():
    global maintenance_task
    init_db()
    maintenance_task = asyncio.get_running_loop().create_task(maintenance_loop())


@app.on_event("shutdown")
async def on_shutdown():
    global maintenance_task
    await stop_maintenance(maintenance_task)
    maintenance_task = None
