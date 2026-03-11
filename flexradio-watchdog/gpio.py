"""Optional Raspberry Pi GPIO support.

Provides a thin abstraction over gpiozero for reading/writing GPIO pins.
Falls back gracefully if not running on a Pi or gpiozero is unavailable.

Usage:
    from gpio import GPIOManager, HAS_GPIO

    if HAS_GPIO:
        gpio = GPIOManager()
        gpio.setup_output(17, label="Amp Power")
        gpio.setup_input(27, label="Door Sensor", pull_up=True)
        gpio.set_output(17, True)
        state = gpio.read_input(27)
        all_state = gpio.get_all_state()
"""

import threading

try:
    from gpiozero import LED, Button, DigitalOutputDevice, DigitalInputDevice
    HAS_GPIO = True
except ImportError:
    HAS_GPIO = False


class GPIOManager:
    """Manages GPIO pins with labels and thread-safe state tracking."""

    def __init__(self):
        self.lock = threading.Lock()
        self.outputs = {}   # pin -> {"device": DigitalOutputDevice, "label": str}
        self.inputs = {}    # pin -> {"device": DigitalInputDevice, "label": str}
        self.callbacks = {} # pin -> [callback, ...]

    def setup_output(self, pin, label="", initial=False):
        """Configure a GPIO pin as a digital output."""
        if not HAS_GPIO:
            return
        with self.lock:
            dev = DigitalOutputDevice(pin, initial_value=initial)
            self.outputs[pin] = {"device": dev, "label": label or f"GPIO{pin}"}

    def setup_input(self, pin, label="", pull_up=True):
        """Configure a GPIO pin as a digital input."""
        if not HAS_GPIO:
            return
        with self.lock:
            dev = DigitalInputDevice(pin, pull_up=pull_up)
            self.inputs[pin] = {"device": dev, "label": label or f"GPIO{pin}"}

    def set_output(self, pin, state):
        """Set a digital output pin high (True) or low (False)."""
        with self.lock:
            entry = self.outputs.get(pin)
            if not entry:
                return False
            if state:
                entry["device"].on()
            else:
                entry["device"].off()
            return True

    def read_input(self, pin):
        """Read the current state of an input pin. Returns True/False or None."""
        with self.lock:
            entry = self.inputs.get(pin)
            if not entry:
                return None
            return bool(entry["device"].value)

    def read_output(self, pin):
        """Read the current state of an output pin."""
        with self.lock:
            entry = self.outputs.get(pin)
            if not entry:
                return None
            return bool(entry["device"].value)

    def get_all_state(self):
        """Return a dict of all pin states for the dashboard."""
        with self.lock:
            result = {"outputs": [], "inputs": []}
            for pin, entry in self.outputs.items():
                result["outputs"].append({
                    "pin": pin,
                    "label": entry["label"],
                    "state": bool(entry["device"].value),
                })
            for pin, entry in self.inputs.items():
                result["inputs"].append({
                    "pin": pin,
                    "label": entry["label"],
                    "state": bool(entry["device"].value),
                })
            return result

    def cleanup(self):
        """Release all GPIO resources."""
        with self.lock:
            for entry in self.outputs.values():
                entry["device"].close()
            for entry in self.inputs.values():
                entry["device"].close()
            self.outputs.clear()
            self.inputs.clear()
