"""Entry point: python -m flexradio-watchdog"""

import argparse
import os
import sys

# Add parent directory to path so the package can find itself
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from config import load_config
from app import create_app


def main():
    parser = argparse.ArgumentParser(
        description="FlexRadio SmartSDR watchdog proxy with web UI"
    )
    parser.add_argument("--radio-ip", help="FlexRadio IP address")
    parser.add_argument("--api-port", type=int, help="SmartSDR API port (default: 4992)")
    parser.add_argument("--port", type=int, help="HTTP server port (default: 8080)")
    parser.add_argument("--interval", type=int, help="Check interval in seconds (default: 30)")
    parser.add_argument("--config", default=None,
                        help="Config file path (default: flexradio-watchdog.json next to script)")
    args = parser.parse_args()

    # Config file location
    if args.config:
        config_path = os.path.abspath(args.config)
    else:
        config_path = os.path.join(
            os.path.dirname(os.path.abspath(__file__)),
            "..", "flexradio-watchdog.json"
        )
        config_path = os.path.normpath(config_path)

    config = load_config(config_path)
    config["_config_path"] = config_path

    # CLI args override config file
    if args.radio_ip:
        config["radio_ip"] = args.radio_ip
    if args.api_port:
        config["api_port"] = args.api_port
    if args.port:
        config["http_port"] = args.port
    if args.interval:
        config["interval"] = args.interval

    http_port = config.get("http_port", 8080)

    if not config.get("radio_ip"):
        print("No radio IP configured. Starting in setup mode.")
        print(f"Open http://localhost:{http_port}/wizard to configure.")
    else:
        print(f"FlexRadio watchdog — radio: {config['radio_ip']}:{config.get('api_port', 4992)}")

    print(f"Dashboard: http://localhost:{http_port}/dashboard")
    print()

    app = create_app(config)
    app.run(
        host="0.0.0.0",
        port=http_port,
        debug=False,
        use_reloader=False,
    )


if __name__ == "__main__":
    main()
