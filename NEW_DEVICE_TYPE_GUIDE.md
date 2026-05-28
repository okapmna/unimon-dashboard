# How to Add a New Device Type

This guide walks you through adding a new device type (e.g., `thermostat`) to the dashboard.

---

## Step 1 — Register the Device Type

Open `src/device-types/registry.js` and add a new entry inside the `registry` object:

```js
thermostat: {
    match: (type) => type.includes('thermostat'),
    key: 'thermostat',
    views: {
        main: {
            template: 'iot-dashboard/thermostat32/thermostat',
            body_class: 'p-6 md:p-12 min-h-screen flex flex-col font-sans text-gray-800',
        },
    },
    topics: {
        subscribe: (id) => `thermostat/${id}/data`,
        publish: (id) => `thermostat/${id}/con`,
    },
    dashboard: {
        link: (id) => `/device/${id}`,
        icon: `<svg xmlns="http://www.w3.org/2000/svg" class="h-8 w-8 text-orange-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>`,
        badge_color: 'bg-orange-50 text-orange-600 border border-orange-200',
    },
    defaultName: 'Thermostat',
    hasChart: false,
    filterType: 'thermostat',
},
```

### Field Reference

| Field | Description |
|-------|-------------|
| `match` | Function to detect this type from `device_type` in database |
| `key` | Unique identifier, must match the key in `handlerMap` and `loaders` |
| `views` | EJS template path and `body_class` for each page |
| `topics` | MQTT topics: `subscribe` (device→server) and `publish` (server→device) |
| `dashboard` | Card link, SVG icon, and badge style shown on the dashboard page |
| `defaultName` | Label displayed in filter buttons |
| `hasChart` | Whether the detail page loads chart data |
| `filterType` | Value used by the dashboard filter |

---

## Step 2 — Create an MQTT Handler

Create `src/handlers/thermostat.js`:

```js
async function handleThermostat(device, data, buffer) {
    // Process incoming MQTT messages from the device
    // Save to device_logs, aggregate data, etc.
    console.log(`[Thermostat ${device.device_id}] Data:`, data);
}

module.exports = { handleThermostat };
```

The handler receives three arguments:

| Argument | Type | Description |
|----------|------|-------------|
| `device` | Object | Device row from the database |
| `data` | Object | Parsed JSON from the MQTT message |
| `buffer` | Object | Temporary buffer for data aggregation |

---

## Step 3 — Register the Handler

Open `src/services/DeviceManager.js` and add your handler:

```js
const { handleThermostat } = require('../handlers/thermostat');

const handlerMap = {
  incubator: handleIncubator,
  smartlamp: handleSmartlamp,
  thermostat: handleThermostat,   // ← add here
};
```

---

## Step 4 — Add a Data Loader (optional)

If your detail page needs extra data (e.g., chart history), add a loader in `src/device-types/loaders.js`:

```js
const loaders = {
  // ... existing loaders
  thermostat: async (deviceId) => {
    const [rows] = await pool.query(
        'SELECT temperature, created_at FROM device_logs WHERE device_id = ? ORDER BY created_at DESC LIMIT 20',
        [deviceId]
    );
    return { history: rows.reverse() };
  },
};
```

The returned object is spread into the EJS template as variables.

---

## Step 5 — Create the EJS View

Create `views/iot-dashboard/thermostat32/thermostat.ejs` following this template:

```ejs
<%- include('../../partials/header') %>
<script src="/socket.io/socket.io.js"></script>

<div id="data-container"
    data-device-id="<%= device_data.device_id %>"
    data-role="<%= role %>"
    style="display:none">
</div>

<script>
    const container = document.getElementById('data-container');
    const deviceId = container.dataset.deviceId;
    const isViewer = container.dataset.role === 'viewer';

    const socket = io({
        auth: { username: '<%= username %>', userId: '<%= userId %>' }
    });

    socket.on('connect', () => {
        socket.emit('join-device', deviceId);
    });

    socket.on('joined', (id) => {
        if (id === deviceId) socket.emit('request-info', deviceId);
    });

    socket.on('disconnect', () => {
        // Update status UI to "Disconnected"
    });

    socket.on('mqtt-message', ({ topic, data }) => {
        // Update UI with real-time data from the device
        // e.g., document.getElementById('temperature').innerText = data.temp;
    });

    function sendCommand(command) {
        socket.emit('device-control', { deviceId, command });
    }
</script>

<!-- Your HTML UI here -->

<%- include('../../partials/footer') %>
```

### Key Points for Client Code

- **Never** include MQTT credentials — the server handles all MQTT connections
- Use `socket.emit('join-device', deviceId)` to subscribe to real-time data
- Listen to `mqtt-message` events to receive device data
- Use `socket.emit('device-control', { deviceId, command })` to send commands
- The server validates access before forwarding commands to the MQTT broker

---

## Step 6 — Restart the Server

Once all steps are complete, restart the application.

The new device type will automatically:

- Appear in the dashboard filter buttons
- Appear in the **Add Device** and **Edit Device** form selectors
- Connect to MQTT through `DeviceManager` when a device of this type is added
- Be accessible at `/device/{id}`

**No changes needed** in `routes/web.js`, `controllers/DeviceController.js`, or `server.js`.
