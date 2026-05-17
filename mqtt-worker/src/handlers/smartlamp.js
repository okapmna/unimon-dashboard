const pool = require('../config/db');
const { maybeUpdateFirmwareVersion } = require('./firmware');

async function handleSmartlamp(device, data, buffer) {
  // Persist firmware version on every well-formed payload (Req 9.2).
  await maybeUpdateFirmwareVersion(device, data);

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
