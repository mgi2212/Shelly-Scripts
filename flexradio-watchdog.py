#!/usr/bin/env python3
"""
FlexRadio SmartSDR Health Check Proxy

Periodically connects to the FlexRadio's SmartSDR API (TCP 4992),
sends a ping command to verify the process is alive, then disconnects.
Exposes the result via a lightweight HTTP endpoint for the Shelly
watchdog to query.

The SmartSDR API is text-based on TCP 4992:
  - On connect, radio sends version line(s) and a client handle
  - Client sends: C<seq>|<command>\n
  - Radio replies: R<seq>|<error_code>|<message>\n

This script connects only when it needs to check (once per interval),
keeping the connection as brief as possible to minimize SmartSDR
client notifications.

Usage:
    python flexradio-watchdog.py --radio-ip 192.168.0.25
    python flexradio-watchdog.py --radio-ip 192.168.0.25 --port 8080 --interval 30

The Shelly queries:
    http://<this-host>:<port>/status
    Returns JSON: {"alive": true/false, "last_check": <epoch>, "detail": "..."}
"""

import argparse
import json
import socket
import sys
import threading
import time
from http.server import HTTPServer, BaseHTTPRequestHandler

# ---- SmartSDR ping check ----

def ping_radio(ip, api_port=4992, timeout=5):
    """
    Connect to the SmartSDR API, send a ping command, and verify a response.
    Returns (True, detail_string) if alive, (False, detail_string) if not.
    """
    sock = None
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(timeout)
        sock.connect((ip, api_port))

        # Read the version/banner lines the radio sends on connect.
        # Typically: V<version>\nH<handle>\n (may vary by firmware)
        banner = b""
        try:
            while True:
                chunk = sock.recv(1024)
                if not chunk:
                    break
                banner += chunk
                # Stop reading once we've seen a handle line or enough data
                if b"H" in banner or len(banner) > 4096:
                    break
        except socket.timeout:
            # If banner read times out, the connection itself proves life
            pass

        banner_text = banner.decode("utf-8", errors="replace").strip()

        # Send ping command (sequence number 1)
        sock.sendall(b"C1|ping\n")

        # Read the response
        response = b""
        try:
            while True:
                chunk = sock.recv(1024)
                if not chunk:
                    break
                response += chunk
                if b"\n" in response:
                    break
        except socket.timeout:
            return (False, "ping sent but no response (timeout)")

        response_text = response.decode("utf-8", errors="replace").strip()

        # A valid response starts with R1| (response to sequence 1)
        if response_text.startswith("R1|"):
            parts = response_text.split("|")
            error_code = parts[1] if len(parts) > 1 else "?"
            if error_code == "0" or error_code == "00000000":
                return (True, "ping OK (" + banner_text.split("\n")[0] + ")")
            else:
                return (False, "ping error code: " + error_code)
        elif len(response_text) > 0:
            # Got some response — radio is alive even if format is unexpected
            return (True, "unexpected response but alive: " + response_text[:80])
        else:
            return (False, "empty response")

    except socket.timeout:
        return (False, "connection timed out")
    except ConnectionRefusedError:
        return (False, "connection refused (SmartSDR not running?)")
    except OSError as e:
        return (False, "network error: " + str(e))
    finally:
        if sock:
            try:
                sock.close()
            except OSError:
                pass


# ---- Shared state ----

class RadioStatus:
    def __init__(self):
        self.lock = threading.Lock()
        self.alive = False
        self.last_check = 0
        self.detail = "no check yet"

    def update(self, alive, detail):
        with self.lock:
            self.alive = alive
            self.last_check = time.time()
            self.detail = detail

    def to_dict(self):
        with self.lock:
            return {
                "alive": self.alive,
                "last_check": self.last_check,
                "detail": self.detail,
            }


# ---- Background check thread ----

def check_loop(status, radio_ip, api_port, interval):
    """Periodically ping the radio and update shared status."""
    while True:
        alive, detail = ping_radio(radio_ip, api_port)
        status.update(alive, detail)
        ts = time.strftime("%H:%M:%S")
        state = "ALIVE" if alive else "DOWN"
        print(f"[{ts}] {state}: {detail}")
        time.sleep(interval)


# ---- HTTP server ----

def make_handler(status):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/status":
                data = status.to_dict()
                body = json.dumps(data).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            elif self.path == "/alive":
                # Minimal endpoint — just "1" or "0" for easy Shelly parsing
                data = status.to_dict()
                body = b"1" if data["alive"] else b"0"
                self.send_response(200)
                self.send_header("Content-Type", "text/plain")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            else:
                self.send_response(404)
                self.end_headers()

        def log_message(self, format, *args):
            # Suppress default request logging
            pass

    return Handler


# ---- Main ----

def main():
    parser = argparse.ArgumentParser(
        description="FlexRadio SmartSDR health check proxy for Shelly watchdog"
    )
    parser.add_argument(
        "--radio-ip", required=True, help="FlexRadio IP address"
    )
    parser.add_argument(
        "--api-port", type=int, default=4992, help="SmartSDR API port (default: 4992)"
    )
    parser.add_argument(
        "--port", type=int, default=8080, help="HTTP server port (default: 8080)"
    )
    parser.add_argument(
        "--interval", type=int, default=30, help="Check interval in seconds (default: 30)"
    )
    args = parser.parse_args()

    status = RadioStatus()

    # Start background check thread
    t = threading.Thread(
        target=check_loop,
        args=(status, args.radio_ip, args.api_port, args.interval),
        daemon=True,
    )
    t.start()

    # Start HTTP server
    server = HTTPServer(("0.0.0.0", args.port), make_handler(status))
    print(f"FlexRadio watchdog proxy")
    print(f"  Radio:    {args.radio_ip}:{args.api_port}")
    print(f"  HTTP:     http://0.0.0.0:{args.port}/status")
    print(f"  Interval: {args.interval}s")
    print(f"  Shelly endpoint: http://<this-ip>:{args.port}/alive")
    print()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.server_close()


if __name__ == "__main__":
    main()
