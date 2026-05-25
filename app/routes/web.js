const express = require('express');
const router = express.Router();
const AuthController = require('../controllers/AuthController');
const DeviceController = require('../controllers/DeviceController');
const { checkWebAuth } = require('../middleware/auth');
const pool = require('../src/config/db');

// Public Routes
router.get('/', AuthController.renderLogin);
router.post('/login', AuthController.handleLogin);
router.get('/logout', AuthController.logout);

// Protected Routes (Web)
router.get('/dashboard', checkWebAuth, DeviceController.getDashboard);
router.post('/dashboard', checkWebAuth, DeviceController.handleDashboardPost);
router.post('/devices/:id/share', checkWebAuth, DeviceController.shareDevice);
router.delete('/devices/:id/share/:userId', checkWebAuth, DeviceController.unshareDevice);
router.get('/devices/:id/users', checkWebAuth, DeviceController.getDeviceUsers);

// View Device Details
router.get('/incubator/:id', checkWebAuth, async (req, res) => {
    try {
        const device_id = req.params.id;
        const [rows] = await pool.query(`
            SELECT d.*, du.role
            FROM device d
            JOIN device_user du ON d.device_id = du.device_id
            JOIN user u ON du.user_id = u.user_id
            WHERE d.device_id = ? AND u.user_name = ?
        `, [device_id, req.session.username]);
        if (rows.length === 0) return res.redirect('/dashboard');
        
        const device_data = rows[0];
        const [logs] = await pool.query("SELECT data, created_at FROM device_logs WHERE device_id = ? ORDER BY created_at DESC LIMIT 15", [device_id]);
        
        const chart_labels = [];
        const chart_temp_avg = [];
        const chart_temp_high = [];
        const chart_temp_low = [];
        const chart_hum_avg = [];
        const chart_hum_high = [];
        const chart_hum_low = [];

        logs.forEach(row => {
            try {
                const data = JSON.parse(row.data);
                if (data.temp && data.temp.avg !== undefined) {
                    chart_labels.push(row.created_at);
                    chart_temp_avg.push(data.temp.avg);
                    chart_temp_high.push(data.temp.high);
                    chart_temp_low.push(data.temp.low);
                    chart_hum_avg.push(data.hum.avg);
                    chart_hum_high.push(data.hum.high);
                    chart_hum_low.push(data.hum.low);
                }
            } catch (e) {}
        });

        res.render('iot-dashboard/incubator32/incubator', {
            page_title: device_data.device_name + ' - Control',
            body_class: 'p-6 md:p-12 min-h-screen flex flex-col font-sans text-gray-800',
            device_data,
            role: device_data.role,
            topic_sub: 'incubator/' + device_id + '/data',
            topic_pub: 'incubator/' + device_id + '/con',
            chart_labels: chart_labels.reverse(),
            chart_temp_avg: chart_temp_avg.reverse(),
            chart_temp_high: chart_temp_high.reverse(),
            chart_temp_low: chart_temp_low.reverse(),
            chart_hum_avg: chart_hum_avg.reverse(),
            chart_hum_high: chart_hum_high.reverse(),
            chart_hum_low: chart_hum_low.reverse()
        });
    } catch (e) {
        res.redirect('/dashboard');
    }
});

router.get('/incubator/:id/servo', checkWebAuth, async (req, res) => {
    try {
        const device_id = req.params.id;
        const [rows] = await pool.query(`
            SELECT d.*, du.role
            FROM device d
            JOIN device_user du ON d.device_id = du.device_id
            JOIN user u ON du.user_id = u.user_id
            WHERE d.device_id = ? AND u.user_name = ?
        `, [device_id, req.session.username]);
        if (rows.length === 0) return res.redirect('/dashboard');
        const device_data = rows[0];
        res.render('iot-dashboard/incubator32/servo', {
            page_title: device_data.device_name + ' - Servo Control',
            body_class: 'p-6 md:p-12 min-h-screen flex flex-col font-sans text-gray-800',
            device_data,
            role: device_data.role,
            topic_sub: 'incubator/' + device_id + '/data',
            topic_pub: 'incubator/' + device_id + '/con'
        });
    } catch (e) {
        res.redirect('/dashboard');
    }
});

router.get('/smartlamp/:id', checkWebAuth, async (req, res) => {
    try {
        const device_id = req.params.id;
        const [rows] = await pool.query(`
            SELECT d.*, du.role
            FROM device d
            JOIN device_user du ON d.device_id = du.device_id
            JOIN user u ON du.user_id = u.user_id
            WHERE d.device_id = ? AND u.user_name = ?
        `, [device_id, req.session.username]);
        if (rows.length === 0) return res.redirect('/dashboard');
        const device_data = rows[0];
        res.render('iot-dashboard/smartlamp32/smartlamp', {
            page_title: device_data.device_name + ' - Smart Lamp',
            body_class: 'p-6 sm:p-12 md:p-24 min-h-screen font-sans text-gray-900',
            device_data,
            role: device_data.role,
            topic_sub: 'smartlamp/' + device_id + '/status',
            topic_pub: 'smartlamp/' + device_id + '/control'
        });
    } catch (e) {
        res.redirect('/dashboard');
    }
});

router.get('/profile', checkWebAuth, (req, res) => {
    res.render('profile', {
        page_title: 'User Profile - UNIMQ',
        body_class: 'bg-cream-bg text-dark-text min-h-screen font-sans selection:bg-accent-green selection:text-white pb-20',
        username: req.session.username,
        user_id: req.session.user_id
    });
});

module.exports = router;
