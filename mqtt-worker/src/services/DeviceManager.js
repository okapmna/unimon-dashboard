const mqtt = require('mqtt');
const pool = require('../config/db');
const { handleIncubator } = require('../handlers/incubator');
const { handleSmartlamp } = require('../handlers/smartlamp');

class DeviceManager {
  constructor() {
    this.mqttClients = {};
    this.deviceBuffers = {};
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
    this.deviceBuffers[device.device_id] = {
      type: device.device_type,
      temps: [],
      hums: [],
      lastPower: null,
      lastSave: Date.now()
    };

    client.on('connect', () => {
      console.log(`[Device ${device.device_id}] CONNECTED! Waiting for messages...`);
      
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

      try {
        const data = JSON.parse(rawMsg);
        const buffer = this.deviceBuffers[device.device_id];
        if (!buffer) return;

        if (buffer.type.includes('incubator') || buffer.type.includes('inkubator')) {
          await handleIncubator(device, data, buffer);
        } else if (buffer.type.includes('smartlamp')) {
          await handleSmartlamp(device, data, buffer);
        }
      } catch (e) {
        console.error(`[Device ${device.device_id}] JSON Parse/Process Error:`, e.message);
      }
    });

    client.on('error', (err) => {
      console.log(`[Device ${device.device_id}] Connection Error Path: ${err.message}`);
    });
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
