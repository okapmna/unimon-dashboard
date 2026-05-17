# Product Overview

UNIMONMQ is a simple IoT dashboard for monitoring and controlling MQTT-connected devices (e.g. incubators, smart lamps).

## Core Capabilities

- Real-time monitoring and control of devices over MQTT (WebSocket protocol).
- Background MQTT worker that records sensor data into MariaDB even when the dashboard is closed.
- 5-minute aggregation of sensor readings (avg, median, high, low) for trend analysis.
- Interactive line charts for historical and real-time temperature/humidity trends.
- Multi-user system with role-based access:
  - `admin`: manages users, devices, sharing tokens, and views audit logs.
  - `user`: owns devices and can be granted shared access to other devices.
- Device sharing via redeemable serial-number/token system (`user_device_access`, `device_access_tokens`).
- Session-based auth with optional "remember me" cookie (selector + hashed validator).

## Primary User Flows

- Login/Register, then land on `/dashboard` (user) or `/admin/users` (admin).
- View per-device pages under `/iot/incubator/:deviceId` and `/iot/smartlamp/:deviceId`.
- Redeem a serial number from the dashboard to gain access to a shared device.
- Admin manages users and devices under `/admin/*` with all admin actions written to `admin_audit_log`.
