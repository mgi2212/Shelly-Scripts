"""Network discovery: FlexRadio, Shelly devices, and UPnP port forwarding."""

import socket
import time

# Optional imports — features degrade gracefully
try:
    import miniupnpc
    HAS_UPNP = True
except ImportError:
    HAS_UPNP = False

try:
    from zeroconf import ServiceBrowser, Zeroconf
    HAS_ZEROCONF = True
except ImportError:
    HAS_ZEROCONF = False


def discover_flexradios(timeout=5):
    """
    Listen for FlexRadio VITA-49 discovery broadcasts on UDP 4992.
    Returns a list of dicts with radio info (ip, model, serial, etc.).
    """
    found = {}
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(("", 4992))
        sock.settimeout(1)
    except OSError as e:
        return {"error": f"Cannot bind UDP 4992: {e}", "radios": []}

    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            data, addr = sock.recvfrom(4096)
            payload = data.decode("utf-8", errors="replace")
            info = _parse_discovery(payload, addr[0])
            key = info.get("serial", addr[0])
            if key not in found:
                found[key] = info
        except socket.timeout:
            continue
        except Exception:
            continue

    sock.close()
    return {"radios": list(found.values())}


def _parse_discovery(payload, source_ip):
    """Parse key=value pairs from a FlexRadio discovery payload."""
    info = {"ip": source_ip}
    # Skip binary VITA-49 header — find first readable key
    for marker in ("discovery_protocol_version=", "model=", "serial="):
        idx = payload.find(marker)
        if idx >= 0:
            text = payload[idx:]
            for part in text.split():
                if "=" in part:
                    k, _, v = part.partition("=")
                    info[k] = v
            break
    return info


def discover_shellys(timeout=5):
    """
    Discover Shelly devices via mDNS (_shelly._tcp.local.).
    Returns a list of dicts with device info.
    Requires the zeroconf library.
    """
    if not HAS_ZEROCONF:
        return {"error": "zeroconf library not installed (pip install zeroconf)", "devices": []}

    found = []

    class Listener:
        def add_service(self, zc, type_, name):
            info = zc.get_service_info(type_, name)
            if info and info.addresses:
                ip = socket.inet_ntoa(info.addresses[0])
                props = {}
                if info.properties:
                    for k, v in info.properties.items():
                        try:
                            props[k.decode()] = v.decode()
                        except (AttributeError, UnicodeDecodeError):
                            props[str(k)] = str(v)
                found.append({
                    "name": name,
                    "ip": ip,
                    "port": info.port,
                    "properties": props,
                })

        def remove_service(self, zc, type_, name):
            pass

        def update_service(self, zc, type_, name):
            pass

    zc = Zeroconf()
    browser = ServiceBrowser(zc, "_shelly._tcp.local.", Listener())
    time.sleep(timeout)
    zc.close()
    return {"devices": found}


def test_tcp_connection(ip, port, timeout=3):
    """Test if a TCP connection can be made to ip:port."""
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(timeout)
        sock.connect((ip, int(port)))
        sock.close()
        return {"ok": True, "detail": f"Connected to {ip}:{port}"}
    except socket.timeout:
        return {"ok": False, "detail": f"Connection timed out ({ip}:{port})"}
    except ConnectionRefusedError:
        return {"ok": False, "detail": f"Connection refused ({ip}:{port})"}
    except OSError as e:
        return {"ok": False, "detail": f"Error: {e}"}


def upnp_discover():
    """Discover the UPnP IGD (router) and return external IP info."""
    if not HAS_UPNP:
        return {"error": "miniupnpc library not installed (pip install miniupnpc)"}

    try:
        u = miniupnpc.UPnP()
        u.discoverdelay = 200
        ndevices = u.discover()
        if ndevices == 0:
            return {"error": "No UPnP gateway found. Is UPnP enabled on your router?"}
        u.selectigd()
        return {
            "external_ip": u.externalipaddress(),
            "lan_ip": u.lanaddr,
            "devices_found": ndevices,
        }
    except Exception as e:
        return {"error": str(e)}


def upnp_add_mapping(external_port, internal_ip, internal_port, description, protocol="TCP"):
    """Add a single UPnP port mapping."""
    if not HAS_UPNP:
        return {"error": "miniupnpc not installed"}

    try:
        u = miniupnpc.UPnP()
        u.discoverdelay = 200
        u.discover()
        u.selectigd()
        u.addportmapping(
            int(external_port), protocol, internal_ip,
            int(internal_port), description, ""
        )
        return {
            "ok": True,
            "external_port": external_port,
            "internal": f"{internal_ip}:{internal_port}",
            "description": description,
        }
    except Exception as e:
        return {"ok": False, "error": str(e)}


def upnp_setup_forwarding(config):
    """Set up UPnP port forwarding for both Flask UI and Shelly device."""
    results = {"mappings": []}

    info = upnp_discover()
    if "error" in info:
        results["error"] = info["error"]
        return results
    results["external_ip"] = info["external_ip"]
    results["lan_ip"] = info["lan_ip"]

    # Forward Flask UI
    flask_port = config.get("http_port", 8080)
    flask_ext = config.get("upnp_flask_external_port", flask_port)
    r = upnp_add_mapping(flask_ext, info["lan_ip"], flask_port, "FlexRadio Watchdog UI")
    results["mappings"].append(r)

    # Forward Shelly web UI
    shelly_ip = config.get("shelly_ip")
    if shelly_ip:
        shelly_ext = config.get("upnp_shelly_external_port", 8081)
        r = upnp_add_mapping(shelly_ext, shelly_ip, 80, "Shelly Device UI")
        results["mappings"].append(r)

    return results
