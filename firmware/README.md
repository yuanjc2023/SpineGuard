# SpineGuard ESP32-S3 Firmware

This firmware samples five FSR channels on an ESP32-S3, classifies posture with deterministic rules, and sends one complete Telemetry V1 JSON message to FastAPI about every two seconds.

## FSR inputs

Each channel uses 16 ADC samples per local sample and applies an independent calibration pair (`empty_raw` and `pressed_raw`) in `main/app_main.c`. The initial calibration is `empty_raw=4095` and `pressed_raw=0`; it must be calibrated with real hardware later.

| FSR field | GPIO | ADC channel |
| --- | --- | --- |
| `pressure.left` | GPIO4 | ADC1_CH3 |
| `pressure.right` | GPIO5 | ADC1_CH4 |
| `pressure.front` | GPIO6 | ADC1_CH5 |
| `pressure.back` | GPIO7 | ADC1_CH6 |
| `pressure.center` | GPIO8 | ADC1_CH7 |

Raw ADC values are printed only in serial debug logs. They are not included in uploaded JSON, which strictly follows `shared/schema.json`.

## Time and upload behavior

After Wi-Fi receives an IP address, the firmware starts SNTP and waits for a valid Unix time. It continues local sampling while time is unavailable, but does not make HTTP uploads until synchronization succeeds. `timestamp_ms` is Unix epoch milliseconds, never boot uptime.

The endpoint is configured by `CONFIG_SPINEGUARD_BACKEND_URL` and must be the complete `POST /api/v1/device/telemetry` URL. Use a LAN-reachable address, for example `http://192.168.1.20:8000/api/v1/device/telemetry`; do not use `127.0.0.1`, because that would refer to the ESP32 itself.

## Configuration

```powershell
idf.py set-target esp32s3
idf.py menuconfig
```

Open **SpineGuard** and set:

- Wi-Fi SSID and password;
- backend URL;
- device token and device ID;
- SNTP server (default: `pool.ntp.org`);
- vibration reminder enable switch (off by default).

`vibration_enabled` in telemetry reflects this configuration. The firmware does not yet drive a physical vibration motor.

## Current placeholders

- `imu.tilt_x`, `imu.tilt_y`, and `imu.shake_level` are `0.0` because no IMU is connected.
- `battery_level` is `100` because this USB-powered prototype has no battery measurement.

## Build

```powershell
idf.py build
```

Flashing and serial-monitor commands are intentionally not run by this project documentation.
