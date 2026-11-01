const http = require('http');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const swaggerUi = require('swagger-ui-express');
const env = require('./config/env');
const { prisma, connectDatabase } = require('./config/database');
const influx = require('./config/influxdb');
const mqttConfig = require('./config/mqtt');
const { initializeSocket } = require('./websocket/socket');
const mqttService = require('./services/mqtt.service');
const { startScheduleWorker } = require('./services/schedule.service');
const apiRoutes = require('./routes');
const { notFound, errorHandler } = require('./middleware/errorHandler');
const logger = require('./utils/logger');
const { MAX_NODE_ID } = require('./config/nodes');

const app = express();
const server = http.createServer(app);
const io = initializeSocket(server);
let scheduleTask;

const pathParameter = (name, minimum, maximum) => ({
  name,
  in: 'path',
  required: true,
  schema: { type: 'integer', minimum, maximum }
});
const endpoint = (summary, { isPublic = false, parameters = [], body } = {}) => {
  const operation = {
    summary,
    parameters,
    responses: {
      200: { description: 'Request completed' },
      201: { description: 'Resource created' },
      400: { description: 'Invalid request' },
      401: { description: 'Authentication required' },
      404: { description: 'Resource not found' },
      422: { description: 'Validation failed' }
    }
  };
  if (isPublic) operation.security = [];
  if (body) {
    operation.requestBody = {
      required: true,
      content: { 'application/json': { schema: { type: 'object', properties: body } } }
    };
  }
  return operation;
};

const swaggerDocument = {
  openapi: '3.0.3',
  info: { title: 'Jamur Janggel Monitor API', version: '1.0.0' },
  servers: [{ url: '/api' }],
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } }
  },
  security: [{ bearerAuth: [] }],
  paths: {
    '/auth/register': { post: endpoint('Create account (administrator only)', { body: {
      email: { type: 'string', format: 'email' }, name: { type: 'string' }, password: { type: 'string', minLength: 8 }
    } }) },
    '/auth/login': { post: endpoint('Login and get JWT', { isPublic: true, body: {
      email: { type: 'string', format: 'email' }, password: { type: 'string' }
    } }) },
    '/auth/forgot-password': { post: endpoint('Send password-reset email', { isPublic: true, body: {
      email: { type: 'string', format: 'email' }
    } }) },
    '/auth/reset-password': { post: endpoint('Reset password', { isPublic: true, body: {
      token: { type: 'string' }, password: { type: 'string', minLength: 8 }
    } }) },
    '/auth/me': { get: endpoint('Get current account') },
    '/debug/mqtt/status': { get: endpoint('Get MQTT broker connection status') },
    '/debug/mqtt/messages': { get: endpoint('Get the latest MQTT messages received') },
    '/debug/mqtt/publish': { post: endpoint('Publish a harmless MQTT debug test message') },
    '/nodes': { get: endpoint('List shared Node 1 and Node 2') },
    '/nodes/{nodeId}': {
      get: endpoint('Get node details', { parameters: [pathParameter('nodeId', 1, MAX_NODE_ID)] }),
      put: endpoint('Update node configuration', {
        parameters: [pathParameter('nodeId', 1, MAX_NODE_ID)],
        body: {
          name: { type: 'string' }, location: { type: 'string', nullable: true },
          isActive: { type: 'boolean' }, mode: { type: 'string', enum: ['auto', 'manual'] },
          targetTemp: { type: 'number' }, targetRh: { type: 'number' }, targetSoil: { type: 'number' }
        }
      })
    },
    '/nodes/{nodeId}/mode': { post: endpoint('Set node mode', {
      parameters: [pathParameter('nodeId', 1, MAX_NODE_ID)], body: { mode: { type: 'string', enum: ['auto', 'manual'] } }
    }) },
    '/sensor/all/current': { get: endpoint('Get latest readings for all user nodes') },
    '/sensor/{nodeId}/current': { get: endpoint('Get latest sensor values', { parameters: [pathParameter('nodeId', 1, MAX_NODE_ID)] }) },
    '/sensor/{nodeId}/history': { get: endpoint('Query sensor history from InfluxDB', {
      parameters: [
        pathParameter('nodeId', 1, MAX_NODE_ID),
        { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
        { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } },
        { name: 'aggregate', in: 'query', schema: { type: 'string', enum: ['mean', 'max', 'min'], default: 'mean' } },
        { name: 'interval', in: 'query', schema: { type: 'string', enum: ['5m', '1h', '1d'], default: '5m' } }
      ]
    }) },
    '/sensor/{nodeId}/battery': { get: endpoint('Query battery history from InfluxDB', {
      parameters: [
        pathParameter('nodeId', 1, MAX_NODE_ID),
        { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
        { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } },
        { name: 'aggregate', in: 'query', schema: { type: 'string', enum: ['mean', 'max', 'min'], default: 'mean' } },
        { name: 'interval', in: 'query', schema: { type: 'string', enum: ['5m', '1h', '1d'], default: '5m' } }
      ]
    }) },
    '/control/pompa': { post: endpoint('Activate the master pump', {
      body: { duration: { type: 'integer', minimum: 1, maximum: 3600 } }
    }) },
    '/control/pompa/stop': { post: endpoint('Stop the master pump') },
    '/schedules': {
      get: endpoint('List watering schedules'),
      post: endpoint('Create a watering schedule', { body: {
        nodeId: { type: 'integer', minimum: 1, maximum: MAX_NODE_ID }, name: { type: 'string' },
        time: { type: 'string', pattern: '^(?:[01]\\d|2[0-3]):[0-5]\\d$' },
        duration: { type: 'integer', minimum: 1, maximum: 3600 }, days: { type: 'string', pattern: '^[01]{7}$' },
        isActive: { type: 'boolean', default: true }
      } })
    },
    '/schedules/{id}': {
      put: endpoint('Update a schedule', { parameters: [pathParameter('id', 1)], body: {
        nodeId: { type: 'integer', minimum: 1, maximum: MAX_NODE_ID }, name: { type: 'string' },
        time: { type: 'string' }, duration: { type: 'integer', minimum: 1, maximum: 3600 },
        days: { type: 'string', pattern: '^[01]{7}$' }, isActive: { type: 'boolean' }
      } }),
      delete: endpoint('Delete a schedule', { parameters: [pathParameter('id', 1)] })
    },
    '/schedules/{id}/toggle': { post: endpoint('Toggle a schedule', { parameters: [pathParameter('id', 1)] }) },
    '/notifications': { get: endpoint('List notifications') },
    '/notifications/unread': { get: endpoint('Get unread notification count') },
    '/notifications/read-all': { put: endpoint('Mark all notifications as read') },
    '/notifications/{id}/read': { put: endpoint('Mark a notification as read', { parameters: [pathParameter('id', 1)] }) },
    '/notifications/{id}': { delete: endpoint('Delete a notification', { parameters: [pathParameter('id', 1)] }) },
    '/profile': {
      get: endpoint('Get profile'),
      put: endpoint('Update profile', { body: {
        name: { type: 'string' }, phone: { type: 'string', nullable: true }, address: { type: 'string', nullable: true }
      } })
    },
    '/profile/avatar': { post: {
      ...endpoint('Upload profile avatar'),
      requestBody: { required: true, content: { 'multipart/form-data': { schema: {
        type: 'object', properties: { avatar: { type: 'string', format: 'binary' } }
      } } } }
    } },
    '/profile/password': { put: endpoint('Change password', { body: {
      currentPassword: { type: 'string' }, newPassword: { type: 'string', minLength: 8 }
    } }) },
    '/settings': {
      get: endpoint('Get settings'),
      put: endpoint('Update settings', { body: {
        language: { type: 'string', enum: ['id', 'en'] }, darkMode: { type: 'boolean' },
        refreshInterval: { type: 'integer', minimum: 1000, maximum: 60000 },
        dataRetention: { type: 'integer', minimum: 1, maximum: 3650 }, notifications: { type: 'boolean' }
      } })
    },
    '/settings/calibrate': { post: endpoint('Calibrate a sensor', { body: {
      nodeId: { type: 'integer', minimum: 1, maximum: MAX_NODE_ID },
      sensor: { type: 'string', enum: ['temperature', 'humidity', 'soilMoisture'] },
      offset: { type: 'number', minimum: -100, maximum: 100 }
    } }) }
  }
};

app.set('trust proxy', 1);
app.set('io', io);
app.use(helmet());
app.use(cors({
  origin: env.CORS_ORIGIN === '*' ? '*' : env.CORS_ORIGIN.split(',').map((origin) => origin.trim()),
  credentials: false,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  optionsSuccessStatus: 204
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use('/uploads', express.static(require('path').resolve(process.cwd(), env.UPLOAD_DIR), { fallthrough: false }));
app.use('/api', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler(req, res) {
    res.status(429).json({
      success: false,
      message: 'Too many requests',
      errors: [],
      timestamp: new Date().toISOString()
    });
  }
}));
app.use('/api', apiRoutes);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));
app.get('/health', (req, res) => res.json({
  success: true,
  message: 'OK',
  data: { status: 'healthy', influxConfigured: influx.configured, mqttConfigured: Boolean(env.MQTT_HOST) },
  timestamp: new Date().toISOString()
}));
app.use(notFound);
app.use(errorHandler);

async function start() {
  await connectDatabase();
  const mqttClient = mqttConfig.connectMqtt();
  mqttService.startMqtt(mqttClient, io);
  scheduleTask = startScheduleWorker(io);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    // ✅ FIX: bind ke 0.0.0.0 agar menerima koneksi IPv4 dari LAN,
    // bukan hanya IPv6 (::) yang menyebabkan DestinationHostUnreachable dari klien.
    server.listen(env.PORT, '0.0.0.0', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  logger.info(`HTTP server listening on 0.0.0.0:${env.PORT}`);
}

async function shutdown(signal) {
  logger.info(`Received ${signal}, shutting down`);
  const mqttClient = mqttConfig.client;
  if (mqttClient) mqttClient.end(true);
  if (scheduleTask) scheduleTask.stop();
  io.close(async () => {
    try {
      if (influx.writeApi) await influx.writeApi.close();
    } catch (error) {
      logger.error('InfluxDB shutdown failed', { message: error.message });
      process.exitCode = 1;
    } finally {
      await prisma.$disconnect();
    }
  });
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (error) => {
  logger.error('Unhandled promise rejection', { message: error.message, stack: error.stack });
  process.exitCode = 1;
});

if (require.main === module) {
  start().catch(async (error) => {
    logger.error('Server startup failed', { message: error.message, stack: error.stack });
    await prisma.$disconnect();
    process.exitCode = 1;
  });
}

module.exports = { app, server, start };