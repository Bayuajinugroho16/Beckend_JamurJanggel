const express = require('express');
const Joi = require('joi');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const env = require('../config/env');
const controller = require('../controllers/api.controller');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { validate } = require('../middleware/validator');
const { asyncHandler } = require('../utils/helpers');
const { MAX_NODE_ID } = require('../config/nodes');

const router = express.Router();
const route = (handler) => asyncHandler(handler);
const nodeId = Joi.number().integer().min(1).max(MAX_NODE_ID).required();
const idParam = Joi.object({ id: Joi.number().integer().positive().required() });
const nodeParam = Joi.object({ nodeId });
const email = Joi.string().email().max(254).required();
const password = Joi.string().min(8).max(128);

const schemas = {
  register: Joi.object({ email, password: password.required(), name: Joi.string().trim().min(1).max(100).required() }),
  login: Joi.object({ email, password: password.required() }),
  forgot: Joi.object({ email }),
  reset: Joi.object({ token: Joi.string().hex().length(64).required(), password: password.required() }),
  nodeUpdate: Joi.object({
    name: Joi.string().trim().min(1).max(100),
    location: Joi.string().trim().max(200).allow('', null),
    isActive: Joi.boolean(),
    mode: Joi.string().valid('auto', 'manual'),
    targetTemp: Joi.number().min(-20).max(100),
    targetRh: Joi.number().min(0).max(100),
    targetSoil: Joi.number().min(0).max(100)
  }).min(1),
  mode: Joi.object({ mode: Joi.string().valid('auto', 'manual').required() }),
  water: Joi.object({ duration: Joi.number().integer().min(1).max(3600).required() }),
  scheduleCreate: Joi.object({
    nodeId,
    name: Joi.string().trim().min(1).max(100).required(),
    time: Joi.string().pattern(/^(?:[01]\d|2[0-3]):[0-5]\d$/).required(),
    duration: Joi.number().integer().min(1).max(3600).required(),
    days: Joi.string().pattern(/^[01]{7}$/).required(),
    isActive: Joi.boolean().default(true)
  }),
  scheduleUpdate: Joi.object({
    nodeId: Joi.number().integer().min(1).max(MAX_NODE_ID),
    name: Joi.string().trim().min(1).max(100),
    time: Joi.string().pattern(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    duration: Joi.number().integer().min(1).max(3600),
    days: Joi.string().pattern(/^[01]{7}$/),
    isActive: Joi.boolean()
  }).min(1),
  profile: Joi.object({
    name: Joi.string().trim().min(1).max(100).required(),
    phone: Joi.string().trim().max(30).allow('', null),
    address: Joi.string().trim().max(300).allow('', null)
  }),
  changePassword: Joi.object({
    currentPassword: Joi.string().required(),
    newPassword: password.required()
  }),
  settings: Joi.object({
    language: Joi.string().valid('id', 'en'),
    darkMode: Joi.boolean(),
    refreshInterval: Joi.number().integer().min(1000).max(60000),
    dataRetention: Joi.number().integer().min(1).max(3650),
    notifications: Joi.boolean()
  }).min(1),
  calibrate: Joi.object({
    nodeId,
    sensor: Joi.string().valid('temperature', 'humidity', 'soilMoisture').required(),
    offset: Joi.number().min(-100).max(100).required()
  }),
  history: Joi.object({
    from: Joi.date().iso(),
    to: Joi.date().iso(),
    aggregate: Joi.string().valid('mean', 'max', 'min').default('mean'),
    interval: Joi.string().valid('5m', '1h', '1d').default('5m')
  })
};

const uploadDirectory = path.resolve(process.cwd(), env.UPLOAD_DIR);
fs.mkdirSync(uploadDirectory, { recursive: true });
const avatarUpload = multer({
  storage: multer.diskStorage({
    destination: uploadDirectory,
    filename: (req, file, callback) => callback(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`)
  }),
  limits: { fileSize: env.MAX_AVATAR_SIZE_MB * 1024 * 1024, files: 1 },
  fileFilter: (req, file, callback) => {
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.mimetype)) {
      return callback(Object.assign(new Error('Avatar must be a JPEG, PNG, WEBP, or GIF image'), { status: 415 }));
    }
    callback(null, true);
  }
});

const authLimiter = require('express-rate-limit').rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
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
});
const auth = express.Router();
auth.post('/register', authenticate, requireAdmin, authLimiter, validate(schemas.register), route(controller.register));
auth.post('/login', authLimiter, validate(schemas.login), route(controller.login));
auth.post('/forgot-password', authLimiter, validate(schemas.forgot), route(controller.forgotPassword));
auth.post('/reset-password', authLimiter, validate(schemas.reset), route(controller.resetPassword));
auth.get('/me', authenticate, route(controller.me));
router.use('/auth', auth);

const protectedRoutes = express.Router();
protectedRoutes.get('/debug/mqtt/status', authenticate, route(controller.mqttStatus));
protectedRoutes.get('/debug/mqtt/messages', authenticate, route(controller.mqttMessages));
protectedRoutes.post('/debug/mqtt/publish', authenticate, route(controller.publishMqttDebugTest));
protectedRoutes.get('/nodes', authenticate, route(controller.listNodes));
protectedRoutes.get('/nodes/:nodeId', authenticate, validate(nodeParam, 'params'), route(controller.getNode));
protectedRoutes.put('/nodes/:nodeId', authenticate, validate(nodeParam, 'params'), validate(schemas.nodeUpdate), route(controller.updateNode));
protectedRoutes.post('/nodes/:nodeId/mode', authenticate, validate(nodeParam, 'params'), validate(schemas.mode), route(controller.setNodeMode));

protectedRoutes.get('/sensor/all/current', authenticate, route(controller.allCurrentSensors));
protectedRoutes.get('/sensor/:nodeId/current', authenticate, validate(nodeParam, 'params'), route(controller.currentSensor));
protectedRoutes.get('/sensor/:nodeId/history', authenticate, validate(nodeParam, 'params'), validate(schemas.history, 'query'), route(controller.sensorHistory));
protectedRoutes.get('/sensor/:nodeId/battery', authenticate, validate(nodeParam, 'params'), validate(schemas.history, 'query'), route(controller.batteryHistory));

protectedRoutes.post('/control/pompa', authenticate, validate(schemas.water), route(controller.controlPompa));
protectedRoutes.post('/control/pompa/stop', authenticate, route(controller.stopPompa));

protectedRoutes.get('/schedules', authenticate, route(controller.listSchedules));
protectedRoutes.post('/schedules', authenticate, validate(schemas.scheduleCreate), route(controller.createSchedule));
protectedRoutes.put('/schedules/:id', authenticate, validate(idParam, 'params'), validate(schemas.scheduleUpdate), route(controller.updateSchedule));
protectedRoutes.delete('/schedules/:id', authenticate, validate(idParam, 'params'), route(controller.deleteSchedule));
protectedRoutes.post('/schedules/:id/toggle', authenticate, validate(idParam, 'params'), route(controller.toggleSchedule));

protectedRoutes.get('/notifications/unread', authenticate, route(controller.unreadCount));
protectedRoutes.put('/notifications/read-all', authenticate, route(controller.markAllNotificationsRead));
protectedRoutes.get('/notifications', authenticate, route(controller.listNotifications));
protectedRoutes.put('/notifications/:id/read', authenticate, validate(idParam, 'params'), route(controller.markNotificationRead));
protectedRoutes.delete('/notifications/:id', authenticate, validate(idParam, 'params'), route(controller.deleteNotification));

protectedRoutes.get('/profile', authenticate, route(controller.getProfile));
protectedRoutes.put('/profile', authenticate, validate(schemas.profile), route(controller.updateProfile));
protectedRoutes.post('/profile/avatar', authenticate, (req, res, next) => {
  avatarUpload.single('avatar')(req, res, (error) => error ? next(error) : next());
}, route(controller.uploadAvatar));
protectedRoutes.put('/profile/password', authenticate, validate(schemas.changePassword), route(controller.changePassword));

protectedRoutes.get('/settings', authenticate, route(controller.getSettings));
protectedRoutes.put('/settings', authenticate, validate(schemas.settings), route(controller.updateSettings));
protectedRoutes.post('/settings/calibrate', authenticate, validate(schemas.calibrate), route(controller.calibrate));

router.use(protectedRoutes);
module.exports = router;
