from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import API_PREFIX
from ..db import get_db
from ..models import User
from ..schemas import LoginRequest, RegisterRequest, TokenResponse, UserOut
from ..services.auth import create_access_token, get_current_user, hash_secret, new_public_id, verify_secret

router = APIRouter(prefix=f"{API_PREFIX}/auth", tags=["auth"])
compat_router = APIRouter(prefix=API_PREFIX, tags=["auth"])


@router.post("/register")
def register(data: RegisterRequest, db: Session = Depends(get_db)):
    existing = db.scalar(select(User).where(User.username == data.username))
    if existing is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Username already exists")

    user = User(
        user_id=new_public_id("USR"),
        username=data.username,
        password_hash=hash_secret(data.password),
        role=data.role,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return {"ok": True, "data": user_out(user).model_dump()}


@router.post("/login", response_model=TokenResponse)
def login(data: LoginRequest, db: Session = Depends(get_db)):
    user = db.scalar(select(User).where(User.username == data.username))
    if user is None or not verify_secret(data.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid username or password")

    return TokenResponse(access_token=create_access_token(user), user=user_out(user))


@router.get("/me")
def me(current_user: User = Depends(get_current_user)):
    return {"ok": True, "data": user_out(current_user).model_dump()}


@compat_router.get("/me")
def me_compat(current_user: User = Depends(get_current_user)):
    return {"ok": True, "data": user_out(current_user).model_dump()}


def user_out(user: User) -> UserOut:
    return UserOut(user_id=user.user_id, username=user.username, role=user.role)
