'use strict';

const mqtt = require('mqtt');
const pool = require('../config/db');
const { handleIncubator } = require('../handlers/incubator');
const { handleSmartlamp } = require('../handlers/smartlamp');

const HEARTBEAT_INTERVAL_MS = 30 * 1000;

class DeviceManager {
  constructor() {
    this.mqttClients = {};
    this.deviceBuffers = {};
    // Set of `String(device_id)` of devices whose MQTT client is currently
    // in the connected state. Used to scope the heartbeat updates and to
    // avoid double `markDisconnected` work.
    this.connectedDeviceIds = new Set();
    this.heartbeatTimer = null;
  }

  async syncDevices() {
    try {
      const [rows] = await pool.query('SELECT * FROM device');
      const currentDeviceIds = rows.map((r) => r.device_id.toString());

      for (const device of rows) {
        if (!this.mqttClients[device.device_id]) {
          this.connectDevice(device);
        }
      }

      for (const id in this.mqttClients) {
        if (!currentDeviceIds.includes(id)) {
          // Device row is gone; just close the client and drop any local
          // bookkeeping. Do NOT write to device.is_connected (Req 8.4) — the
          // row no longer exists.
          console.log(`[System] Removing device ${id}`);
          if (this.mqttClients[id]) {
            try { this.mqttClients[id].end(); } catch (err) { /* ignore */ }
          }
          delete this.mqttClients[id];
          delete this.deviceBuffers[id];
          this.connectedDeviceIds.delete(id);
        }
      }
    } catch (err) {
      console.error('[System] Sync Database Error:', err.message);
    }
  }

  connectDevice(device) {
    const protocol = (device.broker_port == 8883 || device.broker_port == 8884) ? 'wss' : 'ws';
    const brokerUrl = `${protocol}://${device.broker_url}:${device.broker_port}/mqtt`;

    console.log(`[Device ${device.device_id}] Connecting to ${brokerUrl}...`);

    const client = mqtt.connect(brokerUrl, {
      clientId: `worker_${device.device_id}_${Math.random().toString(16).substr(2, 4)}`,
      username: device.mq_user,
      password: device.mq_pass,
      reconnectPeriod: 5000,
    });

    this.mqttClients[device.device_id] = client;
    this.deviceBuffers[device.device_id] = {
      type: device.device_type,
      temps: [],
      hums: [],
      lastPower: null,
      lastSave: Date.now()
    };

    const deviceIdStr = String(device.device_id);

    client.on('connect', async () => {
      console.log(`[Device ${device.device_id}] CONNECTED! Waiting for messages...`);
      this.connectedDeviceIds.add(deviceIdStr);
      try {
        await pool.query(
          'UPDATE device SET is_connected = 1, last_seen_at = NOW() WHERE device_id = ?',
          [device.device_id]
        );
      } catch (err) {
        console.error(`[Device ${device.device_id}] connect-state UPDATE failed:`, err.message);
      }

      if (device.device_type.includes('incubator') || device.device_type.includes('inkubator')) {
        const topic = `incubator/${device.device_id}/data`;
        client.subscribe(topic);
        console.log(`[Device ${device.device_id}] Subscribed to: ${topic}`);
      } else if (device.device_type.includes('smartlamp')) {
        const topic = `smartlamp/${device.device_id}/status`;
        client.subscribe(topic);
        console.log(`[Device ${device.device_id}] Subscribed to: ${topic}`);
      }
    });

    client.on('message', async (topic, message) => {
      const rawMsg = message.toString();
      console.log(`[Device ${device.device_id}] Received message on [${topic}]: ${rawMsg}`);

      let data;
      try {
        data = JSON.parse(rawMsg);
      } catch (e) {
        console.error(`[Device ${device.device_id}] JSON Parse Error:`, e.message);
        return; // Req 9.3: non-JSON payload skipped
      }

      try {
        const buffer = this.deviceBuffers[device.device_id];
        if (!buffer) return;

        if (buffer.type.includes('incubator') || buffer.type.includes('inkubator')) {
          await handleIncubator(device, data, buffer);
        } else if (buffer.type.includes('smartlamp')) {
          await handleSmartlamp(device, data, buffer);
        }
      } catch (e) {
        console.error(`[Device ${device.device_id}] Handler Error:`, e.message);
      }
    });

    client.on('close', () => this.markDisconnected(deviceIdStr));
    client.on('offline', () => this.markDisconnected(deviceIdStr));
    client.on('error', (err) => {
      console.log(`[Device ${device.device_id}] Connection Error Path: ${err.message}`);
      this.markDisconnected(deviceIdStr);
    });
  }

  async markDisconnected(deviceIdStr) {
    if (!this.connectedDeviceIds.has(deviceIdStr) && deviceIdStr !== undefined) {
      // Already marked disconnected; still attempt the UPDATE to keep DB in sync,
      // but skip if the device row was already removed by syncDevices.
    }
    this.connectedDeviceIds.delete(deviceIdStr);
    try {
      await pool.query(
        'UPDATE device SET is_connected = 0 WHERE device_id = ?',
        [deviceIdStr]
      );
    } catch (err) {
      console.error(`[Device ${deviceIdStr}] disconnect-state UPDATE failed:`, err.message);
    }
  }

  startHeartbeat() {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(async () => {
      const ids = Array.from(this.connectedDeviceIds);
      for (const id of ids) {
        try {
          await pool.query(
            'UPDATE device SET last_seen_at = NOW() WHERE device_id = ?',
            [id]
          );
        } catch (err) {
          console.error(`[Heartbeat] UPDATE failed for device ${id}:`, err.message);
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  gracefulShutdown() {
    console.log('[System] Shutting down MQTT clients...');
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const id in this.mqttClients) {
      if (this.mqttClients[id]) {
        try { this.mqttClients[id].end(); } catch (err) { /* ignore */ }
      }
    }
  }
}

module.exports = new DeviceManager();
