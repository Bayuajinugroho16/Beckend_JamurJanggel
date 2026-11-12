const { prisma } = require('../config/database');
const { writeSensor } = require('./influx.service');
const { notifySensorThreshold } = require('./notification.service');
const logger = require('../utils/logger');
const { MAX_NODE_ID } = require('../config/nodes');

const latest = new Map();
const autoWaterCooldown = new Map();

// ===== UNTUK SKIP SIMPAN =====
const lastSoilValue = new Map();  // Nilai soil terakhir yang disimpan
const lastSaveTime = new Map();   // Waktu terakhir simpan
const SOIL_CHANGE_THRESHOLD = 5;  // Perubahan > 2% dianggap "berubah"
const MAX_SAVE_INTERVAL_MS = 3600000; // 1 jam

const AUTO_SOIL_THRESHOLD = 60;
const AUTO_WATER_DURATION_SECONDS = 5;
const AUTO_WATER_COOLDOWN_MS = 30 * 1000;
const DEBUG_MESSAGE_LIMIT = 50;
const subscribedTopics = [
  'jamur/+/soil',
  'jamur/+/suhu',
  'jamur/+/battery',
  'jamur/+/battery_percent',
  'jamur/+/status',
  'jamur/notifikasi',
  'jamur/debug/test'
];
const messages = [];
let io;
let client;

function setSocketServer(socketServer) {
  io = socketServer;
}

function publish(topic, payload) {
  if (!client || !client.connected) throw Object.assign(new Error('MQTT broker is not connected'), { status: 503 });
  return new Promise((resolve, reject) => {
    client.publish(topic, String(payload), { qos: 1 }, (error) => {
      if (error) {
        logger.error('MQTT publish failed', { topic, message: error.message });
        reject(error);
      } else {
        logger.info('MQTT message published', { topic, payload: String(payload) });
        resolve();
      }
    });
  });
}

async function autoWater(node, reading) {
  if (node.mode === 'manual') {
    logger.info(`[MANUAL] Node ${node.nodeId} soil ${reading.soilMoisture}%, tidak ada aksi otomatis`);
    return;
  }
  if (node.mode !== 'auto' || reading.soilMoisture >= AUTO_SOIL_THRESHOLD) return;

  const now = Date.now();
  const lastWatered = autoWaterCooldown.get(node.nodeId) || 0;
  if (now - lastWatered < AUTO_WATER_COOLDOWN_MS) return;
  autoWaterCooldown.set(node.nodeId, now);

  try {
    await publish('jamur/pompa/perintah', String(AUTO_WATER_DURATION_SECONDS));
  } catch (error) {
    if (autoWaterCooldown.get(node.nodeId) === now) autoWaterCooldown.delete(node.nodeId);
    logger.error('Automatic watering failed', { nodeId: node.nodeId, message: error.message });
    return;
  }

  logger.info(`[AUTO] Node ${node.nodeId} soil ${reading.soilMoisture}% < 60%, pompa nyala 5 detik`);
  try {
    await prisma.log.create({
      data: {
        nodeId: node.id,
        action: 'water',
        duration: AUTO_WATER_DURATION_SECONDS,
        source: 'auto'
      }
    });
  } catch (error) {
    logger.error('Could not persist automatic watering log', {
      nodeId: node.nodeId, message: error.message
    });
  }
  if (io) io.to(`node:${node.nodeId}`).emit('relay:status', {
    nodeId: node.nodeId, isWatering: true, duration: AUTO_WATER_DURATION_SECONDS
  });
}

async function processSensor(nodeId, field, value) {
  const fieldName = {
    suhu: 'temperature',
    soil: 'soilMoisture',
    battery: 'batteryVoltage',
    battery_percent: 'batteryPercent'
  }[field];
  if (!fieldName) return;
  if (field === 'battery_percent' && (value < 0 || value > 100)) {
    logger.warn('Ignoring out-of-range MQTT battery percentage', { nodeId, value });
    return;
  }

  const key = String(nodeId);
  const reading = latest.get(key) || {
    nodeId: Number(nodeId),
    temperature: null,
    soilMoisture: null,
    batteryVoltage: null,
    batteryPercent: null
  };
  reading[fieldName] = value;
  reading.timestamp = new Date().toISOString();
  latest.set(key, reading);

  const node = await prisma.node.findUnique({ where: { nodeId: Number(nodeId) } });
  if (!node) {
    logger.warn('Ignoring sensor reading for unknown MQTT node', { nodeId: Number(nodeId) });
    return;
  }
  if (!node.isActive) return;

  // ===== SELALU KIRIM KE WEBSOCKET (REAL-TIME) =====
  if (io) io.to(`node:${node.nodeId}`).emit('sensor:update', reading);

  // ===== CEK APAKAH PERLU SIMPAN =====
  let shouldSave = true;
  if (field === 'soil') {
    const prevValue = lastSoilValue.get(nodeId);
    const now = Date.now();
    const lastTime = lastSaveTime.get(nodeId) || 0;
    
    const hasChanged = prevValue === undefined || Math.abs(value - prevValue) > SOIL_CHANGE_THRESHOLD;
    const oneHourPassed = (now - lastTime) > MAX_SAVE_INTERVAL_MS;
    
    shouldSave = hasChanged || oneHourPassed;
    
    if (shouldSave) {
      lastSoilValue.set(nodeId, value);
      lastSaveTime.set(nodeId, now);
      logger.info(`[SAVE] Node ${nodeId} soil ${value}% (changed/1h)`);
    } else {
      logger.debug(`[SKIP] Node ${nodeId} soil ${value}% (tidak berubah)`);
    }
  }

  // ===== SIMPAN KE DATABASE (JIKA PERLU) =====
  if (shouldSave) {
    try {
      await prisma.sensorData.create({
        data: {
          nodeId: node.nodeId,
          soil_moisture: reading.soilMoisture,
          temperature: reading.temperature,
          battery_voltage: reading.batteryVoltage,
          battery_percent: reading.batteryPercent,
          createdAt: new Date(reading.timestamp)
        }
      });
    } catch (error) {
      logger.error('Could not persist sensor reading to PostgreSQL', {
        nodeId: node.nodeId, message: error.message
      });
    }
    try {
      await writeSensor({ ...reading, userId: node.userId });
    } catch (error) {
      logger.error('Could not persist sensor reading to InfluxDB', {
        nodeId: node.nodeId, userId: node.userId, message: error.message
      });
    }
  }

  // ===== SELALU PROSES KONTROL OTOMATIS =====
  await notifySensorThreshold(node, reading);
  if (field === 'soil') await autoWater(node, reading);
}

async function processStatus(nodeId, message) {
  let raw = message.toString().trim().toLowerCase();
  try {
    const parsed = JSON.parse(raw);
    raw = String(parsed.status || parsed.online || raw).toLowerCase();
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  const isOnline = raw === 'online' || raw === '1' || raw === 'true';
  const status = { nodeId: Number(nodeId), isOnline, lastUpdate: new Date().toISOString() };
  if (io) {
    io.to(`node:${status.nodeId}`).emit('node:status', status);
  }
}

function startMqtt(clientInstance, socketServer) {
  client = clientInstance;
  io = socketServer;
  if (!client) return;

  client.on('connect', () => {
    logger.info('MQTT connected to broker');
    client.subscribe(subscribedTopics, { qos: 1 }, (error, granted) => {
      if (error) {
        const rejectedTopics = error.packet?.granted
          ?.flatMap((reasonCode, index) => reasonCode >= 0x80
            ? [{ topic: granted?.[index]?.topic, reasonCode }]
            : []) || [];
        logger.error('MQTT subscription failed', {
          message: error.message,
          ...(rejectedTopics.length > 0 ? { rejectedTopics } : {})
        });
      } else {
        logger.info('Subscribed to MQTT topics', { granted });
      }
    });
  });

  client.on('message', (topic, message) => {
    const payload = message.toString();
    const receivedAt = new Date().toISOString();
    logger.info('MQTT message received', { topic, payload });
    messages.push({ topic, payload, timestamp: receivedAt });
    if (messages.length > DEBUG_MESSAGE_LIMIT) messages.shift();

    if (topic === 'jamur/debug/test') return;

    const statusMatch = topic.match(/^jamur\/node(\d+)\/status$/);
    const sensorMatch = topic.match(/^jamur\/node(\d+)\/(soil|suhu|battery|battery_percent)$/);
    if (topic === 'jamur/notifikasi') {
      handleBroadcastNotification(message).catch((error) => logger.error('MQTT notification handling failed', { message: error.message }));
    } else if (statusMatch) {
      const nodeId = Number(statusMatch[1]);
      if (nodeId < 1 || nodeId > MAX_NODE_ID) return;
      processStatus(statusMatch[1], message).catch((error) => logger.error('MQTT status handling failed', { message: error.message }));
    } else if (sensorMatch) {
      const nodeId = Number(sensorMatch[1]);
      if (nodeId < 1 || nodeId > MAX_NODE_ID) return;
      const value = Number(message.toString());
      if (!Number.isFinite(value)) {
        logger.warn('Ignoring invalid MQTT sensor payload', { topic });
        return;
      }
      processSensor(sensorMatch[1], sensorMatch[2], value)
        .catch((error) => logger.error('MQTT sensor handling failed', { topic, message: error.message }));
    }
  });
}

function getStatus() {
  return {
    connected: Boolean(client && client.connected),
    messages: messages.slice(-10)
  };
}

function getMessages() {
  return messages.slice(-10);
}

async function handleBroadcastNotification(payload) {
  const parsed = JSON.parse(payload.toString());
  if (!parsed || typeof parsed.title !== 'string' || typeof parsed.message !== 'string') {
    throw new Error('Invalid notification payload');
  }
  const users = await prisma.user.findMany({ select: { id: true } });
  const { createNotification } = require('./notification.service');
  for (const user of users) {
    await createNotification({ userId: user.id, title: parsed.title, message: parsed.message, type: parsed.type || 'info' });
  }
}

function getLatest(nodeIds) {
  return nodeIds.map((nodeId) => latest.get(String(nodeId)) || {
    nodeId,
    temperature: null,
    soilMoisture: null,
    batteryVoltage: null,
    batteryPercent: null,
    timestamp: null
  });
}

module.exports = { startMqtt, setSocketServer, publish, getLatest, getStatus, getMessages };