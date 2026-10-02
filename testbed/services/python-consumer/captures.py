"""A bounded in-memory capture sink (see node-consumer/lib/captures.mjs)."""

import threading

MAX_ENTRIES = 100
MAX_ENTRY_BYTES = 4096


class BoundedCaptures:
    def __init__(self):
        self._lock = threading.Lock()
        self._entries = []

    def add(self, label, text):
        with self._lock:
            self._entries.append({"label": str(label)[:80], "body": str(text)[:MAX_ENTRY_BYTES]})
            del self._entries[:-MAX_ENTRIES]

    def snapshot(self):
        with self._lock:
            return [dict(e) for e in self._entries]

    def reset(self):
        with self._lock:
            self._entries = []
