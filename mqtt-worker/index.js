const deviceManager = require('./src/services/DeviceManager');
const pool = require('./src/config/db');

async function startWorker() {
  console.log('--- MQTT BACKGROUND WORKER STARTED ---');
  
  // Initial sync
  await deviceManager.syncDevices();
  
  // Sync periodically
  setInterval(() => {
    deviceManager.syncDevices();
  }, 20000);
}

startWorker();

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Caught SIGINT. Shutting down gracefully...');
  deviceManager.gracefulShutdown();
  await pool.end();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Caught SIGTERM. Shutting down gracefully...');
  deviceManager.gracefulShutdown();
  await pool.end();
  process.exit(0);
});
