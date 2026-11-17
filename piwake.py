# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Session-scoped, event-driven wake transport for the Pi extension."""

import asyncio
import json

from aiohttp import web

WAKE_TTL_SECONDS = 10
MAX_PENDING = 256


class Connections:
    def __init__(self, changed):
        self._connections = {}
        self._changed = changed
        self._closing = False

    @staticmethod
    def key(identity):
        return identity["id"], identity["created"]

    def connected(self, identity):
        return self.key(identity) in self._connections

    async def stream(self, request, identity):
        key = self.key(identity)
        if self._closing:
            raise web.HTTPServiceUnavailable()
        if key in self._connections:
            raise web.HTTPConflict(text="Pi wake stream already connected")
        response = web.StreamResponse(headers={"Content-Type": "application/x-ndjson",
                                               "Cache-Control": "no-store"})
        connection = {"queue": asyncio.Queue(maxsize=1), "pending": {}}
        self._connections[key] = connection
        try:
            await response.prepare(request)
            await response.write(b'{"ready":true}\n')
            self._changed()
            while True:
                try:
                    item = await asyncio.wait_for(connection["queue"].get(), 15)
                except asyncio.TimeoutError:
                    item = {"heartbeat": True}
                if item is None:
                    break
                await response.write((json.dumps(item, separators=(",", ":")) + "\n").encode())
        except (ConnectionError, asyncio.CancelledError, RuntimeError):
            pass
        finally:
            if self._connections.get(key) is connection:
                del self._connections[key]
            for state in connection["pending"].values():
                state["timer"].cancel()
            self._changed()
        return response

    async def close(self):
        self._closing = True
        for connection in tuple(self._connections.values()):
            queue = connection["queue"]
            if queue.full():
                queue.get_nowait()
            queue.put_nowait(None)

    async def notify(self, request):
        connection = self._connections.get((request["name"], request["created"]))
        if connection is None:
            return {"reason": "not_connected"}
        notification_id = request["notification_id"]
        state = connection["pending"].get(notification_id)
        if state is not None:
            if state["confirmed"]:
                state["timer"].cancel()
                del connection["pending"][notification_id]
                return {"ok": True, "accepted": True}
            return {"reason": "not_confirmed"}
        if len(connection["pending"]) >= MAX_PENDING:
            return {"reason": "not_confirmed"}

        def expire():
            state = connection["pending"].get(notification_id)
            if state is not None:
                del connection["pending"][notification_id]
                self._changed()

        timer = asyncio.get_running_loop().call_later(WAKE_TTL_SECONDS, expire)
        connection["pending"][notification_id] = {"confirmed": False, "timer": timer}
        try:
            connection["queue"].put_nowait({"notification_id": notification_id,
                                            "count": request["count"]})
            return {"reason": "not_confirmed"}
        except asyncio.QueueFull:
            timer.cancel()
            del connection["pending"][notification_id]
            return {"reason": "not_confirmed"}

    def acknowledge(self, identity, notification_id):
        connection = self._connections.get(self.key(identity))
        if connection is None:
            return False
        state = connection["pending"].get(notification_id)
        if state is None:
            return False
        state["confirmed"] = True
        self._changed()
        return True
