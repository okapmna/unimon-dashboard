const pool = require('../config/db');

async function handleIncubator(device, data, buffer) {
  // Inisialisasi lastTemp dan lastHum jika belum ada
  if (buffer.lastTemp === undefined) {
    buffer.lastTemp = parseFloat(data.temperature) || 0;
  }
  if (buffer.lastHum === undefined) {
    buffer.lastHum = parseFloat(data.humidity) || 0;
  }

  let hasData = false;
  let saveTriggered = false;
  let currentTemp = 0;
  let currentHum = 0;

  if (data.temperature !== undefined) {
    currentTemp = parseFloat(data.temperature);
    buffer.temps.push(currentTemp);
    hasData = true;

    const tempDiff = Math.abs(currentTemp - buffer.lastTemp);
    if (tempDiff >= 1) {
      saveTriggered = true;
      buffer.lastTemp = currentTemp;
    }
  }
  
  if (data.humidity !== undefined) {
    currentHum = parseFloat(data.humidity);
    buffer.hums.push(currentHum);
    hasData = true;

    // Cek kondisi perubahan drastis kelembapan
    const humDiff = Math.abs(currentHum - buffer.lastHum);
    if (humDiff >= 10) {
      saveTriggered = true;
      buffer.lastHum = currentHum;
    }
  }
  
  if (hasData) {
    console.log(`[Device ${device.device_id}] Sample added. Total samples: ${buffer.temps.length}`);
  } else {
    console.log(`[Device ${device.device_id}] Warning: Received data but 'temperature' or 'humidity' keys are missing!`);
  }
  
  const now = Date.now();
  if (saveTriggered) {
    if (buffer.temps.length > 0 || buffer.hums.length > 0) {
      
      const getStats = (arr) => {
        if (arr.length === 0) return { avg: 0, median: 0, high: 0, low: 0 };
        const sorted = [...arr].sort((a, b) => a - b);
        const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
        const median = sorted[Math.floor(sorted.length / 2)];
        return {
          avg: parseFloat(avg.toFixed(2)),
          median: parseFloat(median.toFixed(2)),
          high: parseFloat(sorted[sorted.length - 1].toFixed(2)),
          low: parseFloat(sorted[0].toFixed(2))
        };
      };

      const summary = {
        temp: getStats(buffer.temps),
        hum: getStats(buffer.hums),
        samples: buffer.temps.length,
        reason: "drastic_change"
      };

      await pool.query('INSERT INTO device_logs (device_id, data) VALUES (?, ?)', 
        [device.device_id, JSON.stringify(summary)]);
      
      console.log(`[Device ${device.device_id}] LOG SAVED (drastic change):`, JSON.stringify(summary));
    }
    
    buffer.temps = [];
    buffer.hums = [];
    buffer.lastSave = now;
  } else if (now - buffer.lastSave >= 300000) {
    console.log(`[Device ${device.device_id}] No drastic change for 5 minutes. Discarding ${buffer.temps.length} samples.`);
    buffer.temps = [];
    buffer.hums = [];
    buffer.lastSave = now;
  }
}

module.exports = {
  handleIncubator
};
