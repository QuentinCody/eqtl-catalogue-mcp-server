"""Bounded eQTL service. Deploy behind TLS; bind loopback by default."""
import argparse
import hmac
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import subprocess
import sys

from query import MAX_OUTPUT


def run_query(manifest, body):
    try:
        process = subprocess.run([sys.executable, str(Path(__file__).with_name("query.py")), str(manifest)],
                                 input=body, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=30, check=False)
    except subprocess.TimeoutExpired:
        return 504, {"error": "Query exceeded 30 seconds; use offline analysis"}
    if process.returncode or len(process.stdout) > MAX_OUTPUT + 1024:
        return 502, {"error": "Query process failed"}
    try:
        payload = json.loads(process.stdout)
        return payload["status"], payload.get("data", {"error": payload.get("error", "Query failed")})
    except (ValueError, KeyError):
        return 502, {"error": "Invalid query process response"}


def handler(manifest, token):
    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(10)

        def log_message(self, *_args):
            pass

        def send_json(self, status, data):
            body = json.dumps(data, ensure_ascii=False, allow_nan=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            if self.path != "/query":
                return self.send_json(404, {"error": "Unknown route"})
            if not hmac.compare_digest(self.headers.get("Authorization", "").encode(), f"Bearer {token}".encode()):
                return self.send_json(401, {"error": "Unauthorized"})
            lengths = self.headers.get_all("Content-Length", [])
            if self.headers.get("Transfer-Encoding") or len(lengths) != 1 or not lengths[0].isdigit():
                return self.send_json(400, {"error": "One Content-Length is required"})
            length = int(lengths[0])
            if not 0 < length <= 64 * 1024:
                return self.send_json(413, {"error": "Request exceeds 64 KiB"})
            body = self.rfile.read(length)
            if len(body) != length:
                return self.send_json(400, {"error": "Incomplete request"})
            status, result = run_query(manifest, body)
            self.send_json(status, result)

    return Handler


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8098)
    args = parser.parse_args()
    secret = os.environ.get("EQTL_PARQUET_TOKEN", "")
    if len(secret) < 32:
        parser.error("EQTL_PARQUET_TOKEN must contain at least 32 characters")
    # One request at a time bounds process concurrency. The reverse proxy should
    # apply request/queue limits and a memory limit to this service container.
    HTTPServer((args.host, args.port), handler(args.manifest.resolve(), secret)).serve_forever()
