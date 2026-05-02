const pool = require('../config/db');

async function handleSmartlamp(device, data, buffer) {
  if (data.power !== undefined) {
    if (data.power !== buffer.lastPower) {
      const logEntry = { event: "Power Switched", status: data.power };
      await pool.query('INSERT INTO device_logs (device_id, data) VALUES (?, ?)', 
        [device.device_id, JSON.stringify(logEntry)]);
      
      console.log(`[Device ${device.device_id}] LOG SAVED (Power Change):`, data.power);
      buffer.lastPower = data.power;
    }
  }
}

module.exports = {
  handleSmartlamp
};
