const pool = require('../config/db');

async function handleIncubator(device, data, buffer) {
  let hasData = false;
  if (data.temperature !== undefined) {
    buffer.temps.push(parseFloat(data.temperature));
    hasData = true;
  }
  if (data.humidity !== undefined) {
    buffer.hums.push(parseFloat(data.humidity));
    hasData = true;
  }
  
  if (hasData) {
    console.log(`[Device ${device.device_id}] Sample added. Total samples: ${buffer.temps.length}`);
  } else {
    console.log(`[Device ${device.device_id}] Warning: Received data but 'temperature' or 'humidity' keys are missing!`);
  }
  
  const now = Date.now();
  if (now - buffer.lastSave >= 300000) { // 5 Minutes
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
        period: "5m"
      };

      await pool.query('INSERT INTO device_logs (device_id, data) VALUES (?, ?)', 
        [device.device_id, JSON.stringify(summary)]);
      
      console.log(`[Device ${device.device_id}] LOG SAVED TO DATABASE:`, JSON.stringify(summary));
    } else {
      console.log(`[Device ${device.device_id}] 5 minutes passed, but no valid samples were collected.`);
    }
    
    buffer.temps = [];
    buffer.hums = [];
    buffer.lastSave = now;
  }
}

module.exports = {
  handleIncubator
};
