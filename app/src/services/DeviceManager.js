const mqtt = require('mqtt');
const pool = require('../config/db');
const eventBus = require('./eventBus');
const { matchDeviceConfig, getTopicConfig } = require('../device-types/registry');
const { handleIncubator } = require('../handlers/incubator');
const { handleSmartlamp } = require('../handlers/smartlamp');

const handlerMap = {
  incubator: handleIncubator,
  smartlamp: handleSmartlamp,
};

class DeviceManager {
  constructor() {
    this.mqttClients = {};
    this.deviceBuffers = {};
    this.deviceInfo = {};
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
          console.log(`[System] Removing device ${id}`);
          if (this.mqttClients[id]) this.mqttClients[id].end();
          delete this.mqttClients[id];
          delete this.deviceBuffers[id];
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
    this.deviceInfo[device.device_id] = device;
    this.deviceBuffers[device.device_id] = {
      type: device.device_type,
      temps: [],
      hums: [],
      lastPower: null,
      lastSave: Date.now()
    };

    client.on('connect', () => {
      console.log(`[Device ${device.device_id}] CONNECTED! Waiting for messages...`);
      
      const topicConfig = getTopicConfig(device);
      if (topicConfig) {
        client.subscribe(topicConfig.subscribe);
        console.log(`[Device ${device.device_id}] Subscribed to: ${topicConfig.subscribe}`);
      }
    });

    client.on('message', async (topic, message) => {
      const rawMsg = message.toString();
      console.log(`[Device ${device.device_id}] Received message on [${topic}]: ${rawMsg}`);

      try {
        const data = JSON.parse(rawMsg);
        const buffer = this.deviceBuffers[device.device_id];
        if (!buffer) return;

        // Broadcast to Socket.IO clients via event bus
        eventBus.emit('device-data', {
          deviceId: device.device_id,
          topic,
          data
        });

        const handlerConfig = matchDeviceConfig(device.device_type);
        const handler = handlerConfig ? handlerMap[handlerConfig.key] : null;
        if (handler) {
          await handler(device, data, buffer);
        }
      } catch (e) {
        console.error(`[Device ${device.device_id}] JSON Parse/Process Error:`, e.message);
      }
    });

    client.on('error', (err) => {
      if (!err.message.includes('Not authorized')) {
        console.log(`[Device ${device.device_id}] Connection Error: ${err.message}`);
      }
    });
  }
  
  publish(deviceId, payload) {
    const client = this.mqttClients[deviceId];
    const device = this.deviceInfo[deviceId];
    if (!client || !client.connected || !device) return false;

    const topicConfig = getTopicConfig(device);
    if (!topicConfig) return false;

    const msg = typeof payload === 'string' ? payload : JSON.stringify(payload);
    client.publish(topicConfig.publish, msg);
    console.log(`[Device ${deviceId}] Published to [${topicConfig.publish}]: ${msg}`);
    return true;
  }

  gracefulShutdown() {
    console.log('[System] Shutting down MQTT clients...');
    for (const id in this.mqttClients) {
      if (this.mqttClients[id]) {
        this.mqttClients[id].end();
      }
    }
  }
}

module.exports = new DeviceManager();
