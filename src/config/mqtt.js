const mqtt = require('mqtt');
const env = require('./env');
const logger = require('../utils/logger');

let client;

function connectMqtt() {
  if (!env.MQTT_HOST) {
    logger.warn('MQTT is disabled because MQTT_HOST is not configured');
    return null;
  }

  const protocol = Number(env.MQTT_PORT) === 8883 ? 'mqtts' : 'mqtt';
  const options = {
    port: env.MQTT_PORT,
    clientId: `${env.MQTT_CLIENT_ID}-${process.pid}`,
    username: env.MQTT_USERNAME || undefined,
    password: env.MQTT_PASSWORD || undefined,
    clean: true,
    reconnectPeriod: 5000,
    connectTimeout: 30000,
    rejectUnauthorized: env.NODE_ENV === 'production'
  };

  if (!options.rejectUnauthorized) {
    logger.warn('MQTT TLS certificate validation is disabled outside production');
  }

  client = mqtt.connect(`${protocol}://${env.MQTT_HOST}`, options);
  client.on('connect', () => logger.info('Connected to MQTT broker'));
  client.on('reconnect', () => logger.warn('Reconnecting to MQTT broker'));
  client.on('error', (error) => logger.error('MQTT connection error', { message: error.message }));
  client.on('offline', () => logger.warn('MQTT client is offline'));
  client.on('close', () => logger.warn('MQTT connection closed'));
  return client;
}

module.exports = { connectMqtt, get client() { return client; } };
