const EventEmitter = require('events');

class MqttEventBus extends EventEmitter {}
module.exports = new MqttEventBus();
