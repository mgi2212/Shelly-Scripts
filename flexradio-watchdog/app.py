"""Flask application factory and all routes."""

import json
import threading
from functools import wraps

import requests
from flask import (
    Flask, current_app, jsonify, redirect, render_template,
    request, Response, url_for,
)

from radio import RadioStatus, check_loop
from config import save_config
from discovery import (
    discover_flexradios, discover_shellys, test_tcp_connection,
    upnp_discover, upnp_setup_forwarding, HAS_UPNP, HAS_ZEROCONF,
)


# ---- Auth ----

def check_auth(username, password):
    cfg = current_app.config["app_config"]
    return (username == cfg.get("basic_auth_user") and
            password == cfg.get("basic_auth_pass"))


def requires_auth(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        cfg = current_app.config["app_config"]
        if not cfg.get("basic_auth_user"):
            return f(*args, **kwargs)
        auth = request.authorization
        if not auth or not check_auth(auth.username, auth.password):
            return Response(
                "Authentication required", 401,
                {"WWW-Authenticate": 'Basic realm="FlexRadio Watchdog"'},
            )
        return f(*args, **kwargs)
    return decorated


# ---- App factory ----

def create_app(config):
    app = Flask(__name__)
    app.config["app_config"] = config

    status = RadioStatus()
    app.config["radio_status"] = status

    # Start background check thread
    t = threading.Thread(
        target=check_loop,
        args=(status, config.get("radio_ip", ""),
              config.get("api_port", 4992),
              config.get("interval", 30)),
        daemon=True,
    )
    t.start()
    app.config["check_thread"] = t

    # ---- Shelly-compat endpoints (NO auth) ----

    @app.route("/alive")
    def alive():
        data = status.to_dict()
        body = "1" if data["alive"] else "0"
        return Response(body, mimetype="text/plain")

    @app.route("/status")
    def status_json():
        return jsonify(status.to_dict())

    # ---- Pages ----

    @app.route("/")
    @requires_auth
    def index():
        return redirect(url_for("dashboard"))

    @app.route("/dashboard")
    @requires_auth
    def dashboard():
        cfg = app.config["app_config"]
        return render_template("dashboard.html",
                               config=cfg,
                               has_upnp=HAS_UPNP,
                               has_zeroconf=HAS_ZEROCONF)

    @app.route("/wizard")
    @requires_auth
    def wizard():
        cfg = app.config["app_config"]
        return render_template("wizard.html",
                               config=cfg,
                               has_upnp=HAS_UPNP,
                               has_zeroconf=HAS_ZEROCONF)

    # ---- Dashboard API ----

    @app.route("/api/dashboard")
    @requires_auth
    def api_dashboard():
        return jsonify(status.to_dashboard_dict())

    @app.route("/api/shelly-status")
    @requires_auth
    def api_shelly_status():
        shelly_ip = app.config["app_config"].get("shelly_ip")
        if not shelly_ip:
            return jsonify({"error": "No Shelly IP configured"}), 404
        try:
            resp = requests.get(
                f"http://{shelly_ip}/rpc/Shelly.GetStatus", timeout=3
            )
            return jsonify(resp.json())
        except Exception as e:
            return jsonify({"error": str(e)}), 502

    @app.route("/api/watchdog", methods=["POST"])
    @requires_auth
    def api_watchdog():
        shelly_ip = app.config["app_config"].get("shelly_ip")
        if not shelly_ip:
            return jsonify({"error": "No Shelly IP configured"}), 404
        enabled = request.json.get("enabled", True)
        try:
            resp = requests.get(
                f"http://{shelly_ip}/rpc/KVS.Set",
                params={"key": '"watchdog_enabled"', "value": json.dumps(enabled)},
                timeout=5,
            )
            return jsonify(resp.json())
        except Exception as e:
            return jsonify({"error": str(e)}), 502

    @app.route("/api/power-cycle", methods=["POST"])
    @requires_auth
    def api_power_cycle():
        shelly_ip = app.config["app_config"].get("shelly_ip")
        if not shelly_ip:
            return jsonify({"error": "No Shelly IP configured"}), 404
        try:
            resp = requests.get(
                f"http://{shelly_ip}/rpc/Switch.Set",
                params={"id": 1, "on": "true"},
                timeout=5,
            )
            return jsonify(resp.json())
        except Exception as e:
            return jsonify({"error": str(e)}), 502

    # ---- Wizard API ----

    @app.route("/api/wizard/scan-radios", methods=["POST"])
    @requires_auth
    def api_scan_radios():
        timeout = request.json.get("timeout", 5) if request.is_json else 5
        return jsonify(discover_flexradios(timeout=timeout))

    @app.route("/api/wizard/scan-shellys", methods=["POST"])
    @requires_auth
    def api_scan_shellys():
        timeout = request.json.get("timeout", 5) if request.is_json else 5
        return jsonify(discover_shellys(timeout=timeout))

    @app.route("/api/wizard/test-connection", methods=["POST"])
    @requires_auth
    def api_test_connection():
        data = request.json or {}
        ip = data.get("ip", "")
        port = data.get("port", 4992)
        return jsonify(test_tcp_connection(ip, port))

    @app.route("/api/wizard/upnp-discover", methods=["POST"])
    @requires_auth
    def api_upnp_discover():
        return jsonify(upnp_discover())

    @app.route("/api/wizard/upnp-forward", methods=["POST"])
    @requires_auth
    def api_upnp_forward():
        cfg = dict(app.config["app_config"])
        if request.is_json:
            cfg.update(request.json)
        return jsonify(upnp_setup_forwarding(cfg))

    @app.route("/api/wizard/save-config", methods=["POST"])
    @requires_auth
    def api_save_config():
        data = request.json or {}
        cfg = app.config["app_config"]
        config_path = cfg.get("_config_path", "flexradio-watchdog.json")

        # Update config with new values
        for key in ("radio_ip", "api_port", "http_port", "interval",
                     "shelly_ip", "upnp_enabled",
                     "upnp_flask_external_port", "upnp_shelly_external_port",
                     "basic_auth_user", "basic_auth_pass"):
            if key in data:
                cfg[key] = data[key]

        save_config(cfg, config_path)

        # Restart check loop with new config
        old_status = app.config["radio_status"]
        old_status.request_stop()

        new_status = RadioStatus()
        app.config["radio_status"] = new_status
        # Update the closure reference for alive/status endpoints
        nonlocal status
        status = new_status

        t = threading.Thread(
            target=check_loop,
            args=(new_status, cfg.get("radio_ip", ""),
                  cfg.get("api_port", 4992),
                  cfg.get("interval", 30)),
            daemon=True,
        )
        t.start()
        app.config["check_thread"] = t

        return jsonify({"ok": True, "message": "Configuration saved and watchdog restarted"})

    @app.route("/api/config")
    @requires_auth
    def api_config():
        cfg = dict(app.config["app_config"])
        # Don't expose password
        if cfg.get("basic_auth_pass"):
            cfg["basic_auth_pass"] = "********"
        cfg.pop("_config_path", None)
        return jsonify(cfg)

    return app
