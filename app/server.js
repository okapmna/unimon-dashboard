const express = require('express');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const deviceManager = require('./src/services/DeviceManager');
const eventBus = require('./src/services/eventBus');
const pool = require('./src/config/db');
const webRouter = require('./routes/web');
const apiRouter = require('./routes/api');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 8080;

// View Engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Global Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use(session({
    secret: 'unimq-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 30 * 24 * 60 * 60 * 1000 }
}));

// Trace Middleware (Optional)
app.use((req, res, next) => {
    console.log(`${req.method} ${req.url}`);
    res.locals.toast = req.session.toast || null;
    delete req.session.toast;
    res.locals.error = null;
    res.locals.page_title = 'Unimon Dashboard';
    res.locals.body_class = 'font-sans min-h-screen p-6';
    res.locals.base_url = '/';
    next();
});

// Routing
app.use('/', webRouter);
app.use('/api', apiRouter);

// Socket.IO: Authentication & Real-Time Bridge
io.use((socket, next) => {
    const username = socket.handshake.auth.username;
    const userId = socket.handshake.auth.userId;
    if (!username || !userId) return next(new Error('Authentication required'));
    socket.username = username;
    socket.userId = userId;
    next();
});

io.on('connection', (socket) => {
    console.log(`[WS] User connected: ${socket.username}`);

    socket.on('join-device', async (deviceId) => {
        try {
            const [rows] = await pool.query(`
                SELECT 1 FROM device_user du
                JOIN user u ON du.user_id = u.user_id
                WHERE du.device_id = ? AND u.user_id = ?
            `, [deviceId, socket.userId]);
            if (rows.length > 0) {
                socket.join(`device:${deviceId}`);
                socket.emit('joined', deviceId);
                console.log(`[WS] ${socket.username} joined device:${deviceId}`);
            } else {
                socket.emit('error', 'Access denied to device ' + deviceId);
            }
        } catch (err) {
            socket.emit('error', 'Failed to join device');
        }
    });

    socket.on('leave-device', (deviceId) => {
        socket.leave(`device:${deviceId}`);
    });

    socket.on('request-info', (deviceId) => {
        if (!socket.rooms.has(`device:${deviceId}`)) return;
        deviceManager.publish(deviceId, 'dev_getinfo');
    });

    socket.on('device-control', (payload) => {
        const { deviceId, command } = payload;
        if (!socket.rooms.has(`device:${deviceId}`)) {
            return socket.emit('error', 'Access denied');
        }
        deviceManager.publish(deviceId, command);
    });

    socket.on('disconnect', () => {
        console.log(`[WS] User disconnected: ${socket.username}`);
    });
});

// Event Bus: Forward MQTT data to Socket.IO clients
eventBus.on('device-data', ({ deviceId, topic, data }) => {
    io.to(`device:${deviceId}`).emit('mqtt-message', { topic, data });
});

// Start MQTT Worker
(async () => {
    console.log('--- MQTT BACKGROUND WORKER STARTED ---');
    await deviceManager.syncDevices();
    setInterval(() => deviceManager.syncDevices(), 20000);
})();

server.listen(PORT, () => {
    console.log(`Express App listening on port ${PORT}`);
});
