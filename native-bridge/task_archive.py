"""Private, compressed archive for settled browser task records."""

from __future__ import annotations

from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import stat
import time
import zlib


class TaskArchive:
    def __init__(self, path: Path):
        self.path = path

    @contextmanager
    def _connect(self):
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd = os.open(self.path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            info = os.fstat(fd)
            if (
                not stat.S_ISREG(info.st_mode)
                or info.st_uid != os.getuid()
                or stat.S_IMODE(info.st_mode) & 0o077
            ):
                raise ValueError("unsafe task archive")
        finally:
            os.close(fd)
        connection = sqlite3.connect(self.path, timeout=10)
        try:
            connection.execute("PRAGMA synchronous=FULL")
            connection.execute(
                "CREATE TABLE IF NOT EXISTS tasks ("
                "id TEXT PRIMARY KEY, archived_at REAL NOT NULL, "
                "sha256 TEXT NOT NULL, payload BLOB NOT NULL)"
            )
            with connection:
                yield connection
        finally:
            connection.close()

    def put(self, tasks: list[dict]) -> None:
        if not tasks:
            return
        rows = []
        now = time.time()
        for task in tasks:
            raw = json.dumps(
                task, sort_keys=True, separators=(",", ":"), ensure_ascii=False
            ).encode()
            rows.append((task["id"], now, hashlib.sha256(raw).hexdigest(), zlib.compress(raw, 6)))
        with self._connect() as connection:
            connection.executemany(
                "INSERT INTO tasks(id, archived_at, sha256, payload) VALUES(?, ?, ?, ?) "
                "ON CONFLICT(id) DO UPDATE SET archived_at=excluded.archived_at, "
                "sha256=excluded.sha256, payload=excluded.payload",
                rows,
            )

    def get(self, task_id: str) -> dict | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT sha256, payload FROM tasks WHERE id=?", (task_id,)
            ).fetchone()
        if row is None:
            return None
        raw = zlib.decompress(row[1])
        if hashlib.sha256(raw).hexdigest() != row[0]:
            raise ValueError("corrupt task archive record")
        return json.loads(raw)
