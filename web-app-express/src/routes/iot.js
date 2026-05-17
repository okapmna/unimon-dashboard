const express = require('express');
const { pool } = require('../config/db');
const { requireLogin } = require('../middleware/auth');
const { fetchDeviceWithAccess } = require('../services/devices');

const router = express.Router();

function parseChartLogs(rows) {
  const labels = [], tempAvg = [], tempHigh = [], tempLow = [];
  const humAvg = [], humHigh = [], humLow = [];
  for (const row of rows) {
    let data;
    try { data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data; } catch (e) { continue; }
    if (data && data.temp && data.temp.avg !== undefined) {
      labels.push(row.created_at);
      tempAvg.push(data.temp.avg); tempHigh.push(data.temp.high); tempLow.push(data.temp.low);
      humAvg.push(data.hum.avg); humHigh.push(data.hum.high); humLow.push(data.hum.low);
    }
  }
  // Reverse so chart shows oldest -> newest
  return {
    chart_labels: labels.reverse(),
    chart_temp_avg: tempAvg.reverse(),
    chart_temp_high: tempHigh.reverse(),
    chart_temp_low: tempLow.reverse(),
    chart_hum_avg: humAvg.reverse(),
    chart_hum_high: humHigh.reverse(),
    chart_hum_low: humLow.reverse()
  };
}

router.get('/incubator/:deviceId', requireLogin, async (req, res, next) => {
  try {
    const deviceId = parseInt(req.params.deviceId, 10);
    if (!deviceId) return res.redirect('/dashboard');

    const device = await fetchDeviceWithAccess(deviceId, req.session.user);
    if (!device) {
      req.session.toast = { type: 'error', message: 'Akses ditolak!' };
      return res.redirect('/dashboard');
    }

    const [logRows] = await pool.query(
      "SELECT data, created_at FROM device_logs WHERE device_id = ? AND log_type = 'aggregation' ORDER BY created_at DESC LIMIT 15",
      [deviceId]
    );
    const [spikeRows] = await pool.query(
      "SELECT data, created_at FROM device_logs WHERE device_id = ? AND log_type = 'change_event' ORDER BY created_at DESC LIMIT 10",
      [deviceId]
    );

    const chart = parseChartLogs(logRows);
    const isViewer = device.access_type === 'viewer';

    const spikes = spikeRows.map(s => {
      let data;
      try { data = typeof s.data === 'string' ? JSON.parse(s.data) : s.data; } catch (e) { data = null; }
      return { data, created_at: s.created_at };
    }).filter(s => s.data && Array.isArray(s.data.changes));

    res.render('iot/incubator', {
      device,
      deviceId,
      isViewer,
      brokerHost: device.broker_url,
      brokerPort: parseInt(device.broker_port, 10) || 0,
      mqUser: device.mq_user || '',
      mqPass: device.mq_pass || '',
      topicSub: `incubator/${deviceId}/data`,
      topicPub: `incubator/${deviceId}/con`,
      spikes,
      ...chart
    });
  } catch (err) { next(err); }
});

router.get('/smartlamp/:deviceId', requireLogin, async (req, res, next) => {
  try {
    const deviceId = parseInt(req.params.deviceId, 10);
    if (!deviceId) return res.redirect('/dashboard');

    const device = await fetchDeviceWithAccess(deviceId, req.session.user);
    if (!device) {
      req.session.toast = { type: 'error', message: 'Device tidak ditemukan atau Anda tidak memiliki akses!' };
      return res.redirect('/dashboard');
    }

    const isViewer = device.access_type === 'viewer';
    res.render('iot/smartlamp', {
      device,
      deviceId,
      isViewer,
      brokerHost: device.broker_url,
      brokerPort: parseInt(device.broker_port, 10) || 0,
      mqUser: device.mq_user || '',
      mqPass: device.mq_pass || '',
      topicSub: `smartlamp/${deviceId}/status`,
      topicPub: `smartlamp/${deviceId}/control`
    });
  } catch (err) { next(err); }
});

module.exports = router;
