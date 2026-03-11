"""Configuration loading, saving, and defaults."""

import json
import os

DEFAULT_CONFIG = {
    "radio_ip": "",
    "api_port": 4992,
    "http_port": 8080,
    "interval": 30,
    "shelly_ip": "",
    "upnp_enabled": False,
    "upnp_flask_external_port": 8080,
    "upnp_shelly_external_port": 8081,
    "basic_auth_user": "",
    "basic_auth_pass": "",
    "gpio_pins": [],
    # gpio_pins example:
    # [
    #   {"pin": 17, "mode": "output", "label": "Amp Power", "initial": false},
    #   {"pin": 27, "mode": "input",  "label": "Door Sensor", "pull_up": true}
    # ]
}


def load_config(path):
    """Load config from JSON file, falling back to defaults."""
    config = dict(DEFAULT_CONFIG)
    if os.path.exists(path):
        with open(path, "r") as f:
            saved = json.load(f)
        config.update(saved)
    return config


def save_config(config, path):
    """Save config to JSON file (excludes internal keys starting with _)."""
    clean = {k: v for k, v in config.items() if not k.startswith("_")}
    with open(path, "w") as f:
        json.dump(clean, f, indent=2)
