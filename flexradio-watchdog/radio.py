"""RadioStatus, ping_radio(), and check_loop() — core watchdog logic."""

import socket
import threading
import time
from collections import deque


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

        banner = b""
        try:
            while True:
                chunk = sock.recv(1024)
                if not chunk:
                    break
                banner += chunk
                if b"H" in banner or len(banner) > 4096:
                    break
        except socket.timeout:
            pass

        banner_text = banner.decode("utf-8", errors="replace").strip()

        sock.sendall(b"C1|ping\n")

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

        if response_text.startswith("R1|"):
            parts = response_text.split("|")
            error_code = parts[1] if len(parts) > 1 else "?"
            if error_code == "0" or error_code == "00000000":
                return (True, "ping OK (" + banner_text.split("\n")[0] + ")")
            else:
                return (False, "ping error code: " + error_code)
        elif len(response_text) > 0:
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


class RadioStatus:
    """Thread-safe shared state for radio health checks."""

    def __init__(self):
        self.lock = threading.Lock()
        self.alive = False
        self.last_check = 0
        self.detail = "no check yet"
        self.check_count = 0
        self.log_entries = deque(maxlen=100)
        self._stop_event = threading.Event()

    def update(self, alive, detail):
        with self.lock:
            self.alive = alive
            self.last_check = time.time()
            self.detail = detail
            self.check_count += 1
            self.log_entries.append({
                "time": time.strftime("%Y-%m-%d %H:%M:%S"),
                "alive": alive,
                "detail": detail,
            })

    def to_dict(self):
        """Original dict for /status endpoint — unchanged for Shelly compat."""
        with self.lock:
            return {
                "alive": self.alive,
                "last_check": self.last_check,
                "detail": self.detail,
            }

    def to_dashboard_dict(self):
        """Extended dict for dashboard."""
        with self.lock:
            return {
                "alive": self.alive,
                "last_check": self.last_check,
                "detail": self.detail,
                "check_count": self.check_count,
                "log_entries": list(self.log_entries),
            }

    def request_stop(self):
        self._stop_event.set()

    @property
    def should_stop(self):
        return self._stop_event.is_set()


def check_loop(status, radio_ip, api_port, interval):
    """Periodically ping the radio and update shared status."""
    while not status.should_stop:
        if radio_ip:
            alive, detail = ping_radio(radio_ip, api_port)
            status.update(alive, detail)
            ts = time.strftime("%H:%M:%S")
            state = "ALIVE" if alive else "DOWN"
            print(f"[{ts}] {state}: {detail}")
        status._stop_event.wait(timeout=interval)
