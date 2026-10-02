"""Python consumer service (#192). Same shape as node-consumer/server.mjs:
:8080 scenario API, :8081 control API (compose-internal only). No request body
is read and a request can only pick a fixed scenario ID.
"""

import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "contract"))
import envelope  # noqa: E402
from captures import BoundedCaptures  # noqa: E402

HOST = "python"
TIMEOUT = float(os.environ.get("TESTBED_SCENARIO_TIMEOUT_MS", "20000")) / 1000

if os.environ.get("TESTBED_FAULT") == "startup-failure":
    print("testbed fault injection: startup-failure", file=sys.stderr)
    sys.exit(1)

install = json.loads(Path("/opt/consumer/install-manifest.json").read_text())
scrub = envelope.make_scrubber(envelope.load_sentinels(HERE / "contract"))
scenarios = envelope.discover_scenarios(HERE / "scenarios", HOST, HERE / "contract")
captures = BoundedCaptures()
ctx = {"host": HOST, "install": install, "captures": captures}
lock = threading.Lock()


def make_handler(control):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.0"
        timeout = 10

        def log_message(self, *_args):  # no access log: paths and timing only, not needed
            pass

        def _send(self, status, body):
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("cache-control", "no-store")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            path = self.path.split("?")[0]
            if control:
                if path == "/captures":
                    return self._send(200, {"entries": captures.snapshot()})
                return self._send(404, {"error": "not found"})
            if path == "/healthz":
                return self._send(200, {"ok": True, "host": HOST})
            if path == "/provenance":
                return self._send(200, install)
            if path == "/scenarios":
                return self._send(
                    200,
                    {
                        "schema": "redact-secret-adapters/testbed-scenarios-v1",
                        "host": HOST,
                        "scenarios": [
                            {"id": s["id"], "title": s["title"], "classification": s["classification"]}
                            for s in scenarios.values()
                        ],
                    },
                )
            return self._send(404, {"error": "not found"})

        def do_POST(self):
            path = self.path.split("?")[0]
            if control:
                if path == "/reset":
                    captures.reset()
                    return self._send(200, {"ok": True})
                return self._send(404, {"error": "not found"})
            if not path.startswith("/run/"):
                return self._send(404, {"error": "not found"})
            definition = scenarios.get(path[len("/run/") :])
            if definition is None:
                return self._send(404, {"error": "unknown scenario"})
            if not lock.acquire(blocking=False):
                return self._send(409, {"error": "a scenario is already running"})
            try:
                box = {}
                worker = threading.Thread(
                    target=lambda: box.update(result=envelope.run_scenario(definition, HOST, ctx, scrub)), daemon=True
                )
                worker.start()
                worker.join(TIMEOUT)
                if "result" not in box:
                    return self._send(
                        200,
                        {
                            "schema": envelope.RESULT_SCHEMA,
                            "scenarioId": definition["id"],
                            "host": HOST,
                            "classification": definition["classification"],
                            "title": definition["title"],
                            "status": "error",
                            "startedAt": "",
                            "durationMs": int(TIMEOUT * 1000),
                            "assertions": [],
                            "evidence": {},
                            "error": {"code": "timeout", "message": "scenario exceeded its time limit"},
                        },
                    )
                return self._send(200, box["result"])
            finally:
                lock.release()

    return Handler


if __name__ == "__main__":
    control_server = ThreadingHTTPServer(("0.0.0.0", 8081), make_handler(True))
    threading.Thread(target=control_server.serve_forever, daemon=True).start()
    print(f"python consumer ready: {len(scenarios)} scenarios (mode {install['mode']})", flush=True)
    ThreadingHTTPServer(("0.0.0.0", 8080), make_handler(False)).serve_forever()
