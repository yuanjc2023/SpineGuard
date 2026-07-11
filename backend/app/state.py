from collections import defaultdict, deque

from fastapi import WebSocket

from .schemas import Telemetry

latest: dict[str, Telemetry] = {}
history: dict[str, deque[Telemetry]] = defaultdict(lambda: deque(maxlen=5000))
subscribers: dict[str, set[WebSocket]] = defaultdict(set)

