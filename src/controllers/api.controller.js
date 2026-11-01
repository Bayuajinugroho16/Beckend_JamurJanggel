const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const env = require('../config/env');
const { prisma } = require('../config/database');
const mqttService = require('../services/mqtt.service');
const { getLatest } = mqttService;
const { queryHistory } = require('../services/influx.service');
const { apiResponse } = require('../utils/helpers');
const { MAX_NODE_ID } = require('../config/nodes');

function issueToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN });
}

function publicUser(user) {
  const { password, ...safeUser } = user;
  return safeUser;
}

async function ownedNode(userId, hardwareNodeId) {
  const node = await prisma.node.findUnique({ where: { userId_nodeId: { userId, nodeId: Number(hardwareNodeId) } } });
  if (!node) throw Object.assign(new Error('Node not found'), { status: 404 });
  return node;
}

async function sharedNode(hardwareNodeId) {
  const nodeId = Number(hardwareNodeId);
  if (!Number.isInteger(nodeId) || nodeId < 1 || nodeId > MAX_NODE_ID) {
    throw Object.assign(new Error('Node not found'), { status: 404 });
  }
  const node = await prisma.node.findUnique({ where: { nodeId } });
  if (!node) {
    throw Object.assign(new Error('Node not found'), { status: 404 });
  }
  return node;
}

async function ownedSchedule(userId, id) {
  const schedule = await prisma.schedule.findFirst({
    where: { id: Number(id), userId },
    include: { node: true }
  });
  if (!schedule) throw Object.assign(new Error('Schedule not found'), { status: 404 });
  return schedule;
}

async function publishPumpCommand(req, duration, source = 'manual') {
  await mqttService.publish('jamur/pompa/perintah', duration);
  const nodes = await prisma.node.findMany({
    where: { isActive: true, nodeId: { lte: MAX_NODE_ID } }
  });
  const action = duration === 0 ? 'stop' : 'water';

  if (nodes.length) {
    await prisma.$transaction(nodes.map((node) => prisma.log.create({
      data: {
        nodeId: node.id,
        action,
        ...(duration === 0 ? {} : { duration }),
        source
      }
    })));
  }

  const io = req.app.get('io');
  if (io) {
    for (const node of nodes) {
      io.to(`node:${node.nodeId}`).emit('relay:status', {
        nodeId: node.nodeId,
        isWatering: duration > 0,
        duration
      });
    }
  }

  return { isWatering: duration > 0, duration, nodeCount: nodes.length };
}

function scheduleView(schedule) {
  const { node, ...rest } = schedule;
  return { ...rest, nodeId: node.nodeId };
}

function createResetMailer() {
  if (!env.SMTP_HOST || !env.SMTP_FROM) {
    throw Object.assign(new Error('Password reset email is not configured'), { status: 503 });
  }
  return nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined
  });
}

const controller = {
  async register(req, res) {
    const password = await bcrypt.hash(req.body.password, 12);
    const user = await prisma.user.create({
      data: {
        email: req.body.email.toLowerCase(),
        password,
        name: req.body.name,
        role: 'user',
        settings: { create: {} }
      }
    });
    return apiResponse(res, { user: publicUser(user) }, 'Account created', 201);
  },

  async login(req, res) {
    const user = await prisma.user.findUnique({ where: { email: req.body.email.toLowerCase() } });
    if (!user || !(await bcrypt.compare(req.body.password, user.password))) {
      throw Object.assign(new Error('Invalid email or password'), { status: 401 });
    }
    return apiResponse(res, { user: publicUser(user), token: issueToken(user) }, 'Login successful');
  },

  async forgotPassword(req, res) {
    const mailer = createResetMailer();
    const user = await prisma.user.findUnique({ where: { email: req.body.email.toLowerCase() } });
    if (user) {
      const token = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      await prisma.passwordResetToken.deleteMany({ where: { userId: user.id } });
      await prisma.passwordResetToken.create({
        data: { userId: user.id, tokenHash, expiresAt: new Date(Date.now() + 60 * 60 * 1000) }
      });
      const resetUrl = env.FRONTEND_RESET_URL
        ? `${env.FRONTEND_RESET_URL}${env.FRONTEND_RESET_URL.includes('?') ? '&' : '?'}token=${token}`
        : token;
      await mailer.sendMail({
        from: env.SMTP_FROM,
        to: user.email,
        subject: 'Reset password - Jamur Janggel Monitor',
        text: `Gunakan token berikut untuk reset password (berlaku 1 jam): ${resetUrl}`
      });
    }
    return apiResponse(res, null, 'Jika email terdaftar, instruksi reset password telah dikirim');
  },

  async resetPassword(req, res) {
    const tokenHash = crypto.createHash('sha256').update(req.body.token).digest('hex');
    const reset = await prisma.passwordResetToken.findUnique({ where: { tokenHash } });
    if (!reset || reset.expiresAt <= new Date()) {
      throw Object.assign(new Error('Reset token is invalid or expired'), { status: 400 });
    }
    const password = await bcrypt.hash(req.body.password, 12);
    await prisma.$transaction([
      prisma.user.update({ where: { id: reset.userId }, data: { password } }),
      prisma.passwordResetToken.deleteMany({ where: { userId: reset.userId } })
    ]);
    return apiResponse(res, null, 'Password reset successful');
  },

  async me(req, res) {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    return apiResponse(res, publicUser(user));
  },

  async listNodes(req, res) {
    const nodes = await prisma.node.findMany({
      where: { nodeId: { lte: MAX_NODE_ID } },
      orderBy: { nodeId: 'asc' }
    });
    return apiResponse(res, nodes);
  },

  async getNode(req, res) {
    return apiResponse(res, await sharedNode(req.params.nodeId));
  },

  async updateNode(req, res) {
    const node = await ownedNode(req.user.id, req.params.nodeId);
    const config = {
      name: req.body.name ?? node.name,
      location: Object.hasOwn(req.body, 'location') ? req.body.location : node.location,
      targetTemp: req.body.targetTemp ?? node.targetTemp,
      targetRh: req.body.targetRh ?? node.targetRh,
      targetSoil: req.body.targetSoil ?? node.targetSoil,
      isActive: req.body.isActive ?? node.isActive
    };
    await mqttService.publish(`jamur/node${node.nodeId}/pengaturan`, JSON.stringify({
      ...config,
      mode: req.body.mode ?? node.mode
    }));
    const updated = await prisma.node.update({ where: { id: node.id }, data: req.body });
    return apiResponse(res, updated, 'Node configuration updated');
  },

  async setNodeMode(req, res) {
    const node = await sharedNode(req.params.nodeId);
    await mqttService.publish(`jamur/node${node.nodeId}/mode`, req.body.mode);
    const updated = await prisma.node.update({ where: { id: node.id }, data: { mode: req.body.mode } });
    return apiResponse(res, updated, 'Node mode updated');
  },

  async currentSensor(req, res) {
    await sharedNode(req.params.nodeId);
    const data = getLatest([Number(req.params.nodeId)])[0];
    return apiResponse(res, data);
  },

  async allCurrentSensors(req, res) {
    const nodes = await prisma.node.findMany({
      where: { nodeId: { lte: MAX_NODE_ID }, isActive: true },
      select: { nodeId: true }
    });
    return apiResponse(res, getLatest(nodes.map((node) => node.nodeId)));
  },

  async sensorHistory(req, res) {
    await sharedNode(req.params.nodeId);
    const to = req.query.to ? new Date(req.query.to) : new Date();
    const from = req.query.from ? new Date(req.query.from) : new Date(to.getTime() - 24 * 60 * 60 * 1000);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
      throw Object.assign(new Error('from and to must be valid dates and from must precede to'), { status: 422 });
    }
    const data = await queryHistory({
      nodeId: req.params.nodeId, from, to,
      aggregate: req.query.aggregate, interval: req.query.interval
    });
    return apiResponse(res, data);
  },

  async batteryHistory(req, res) {
    await sharedNode(req.params.nodeId);
    const to = req.query.to ? new Date(req.query.to) : new Date();
    const from = req.query.from
      ? new Date(req.query.from)
      : new Date(to.getTime() - 24 * 60 * 60 * 1000);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
      throw Object.assign(new Error('from and to must be valid dates and from must precede to'), { status: 422 });
    }

    const rows = await queryHistory({
      nodeId: req.params.nodeId,
      from,
      to,
      aggregate: req.query.aggregate,
      interval: req.query.interval
    });
    const data = rows
      .filter((row) => row.batteryVoltage != null || row.batteryPercent != null)
      .map(({ timestamp, batteryVoltage, batteryPercent }) => ({
        timestamp,
        batteryVoltage,
        batteryPercent
      }));
    return apiResponse(res, data);
  },

  async controlPompa(req, res) {
    const data = await publishPumpCommand(req, req.body.duration);
    return apiResponse(res, data, 'Pump command sent');
  },

  async stopPompa(req, res) {
    const data = await publishPumpCommand(req, 0);
    return apiResponse(res, data, 'Pump stopped');
  },

  async listSchedules(req, res) {
    const schedules = await prisma.schedule.findMany({
      where: {
        userId: req.user.id,
        node: { is: { nodeId: { lte: MAX_NODE_ID } } }
      },
      include: { node: true },
      orderBy: { createdAt: 'desc' }
    });
    return apiResponse(res, schedules.map(scheduleView));
  },

  async createSchedule(req, res) {
    const node = await sharedNode(req.body.nodeId);
    const schedule = await prisma.schedule.create({
      data: { ...req.body, userId: req.user.id, nodeId: node.id },
      include: { node: true }
    });
    return apiResponse(res, scheduleView(schedule), 'Schedule created', 201);
  },

  async updateSchedule(req, res) {
    const schedule = await ownedSchedule(req.user.id, req.params.id);
    const data = { ...req.body };
    if (data.nodeId !== undefined) {
      const node = await sharedNode(data.nodeId);
      data.nodeId = node.id;
    }
    const updated = await prisma.schedule.update({
      where: { id: schedule.id }, data, include: { node: true }
    });
    return apiResponse(res, scheduleView(updated), 'Schedule updated');
  },

  async deleteSchedule(req, res) {
    const schedule = await ownedSchedule(req.user.id, req.params.id);
    await prisma.schedule.delete({ where: { id: schedule.id } });
    return apiResponse(res, null, 'Schedule deleted');
  },

  async toggleSchedule(req, res) {
    const schedule = await ownedSchedule(req.user.id, req.params.id);
    const updated = await prisma.schedule.update({
      where: { id: schedule.id }, data: { isActive: !schedule.isActive }, include: { node: true }
    });
    return apiResponse(res, scheduleView(updated), 'Schedule status updated');
  },

  async listNotifications(req, res) {
    const notifications = await prisma.notification.findMany({
      where: { userId: req.user.id }, orderBy: { createdAt: 'desc' }, take: 100
    });
    return apiResponse(res, notifications);
  },

  async unreadCount(req, res) {
    const count = await prisma.notification.count({ where: { userId: req.user.id, isRead: false } });
    return apiResponse(res, { count });
  },

  async markNotificationRead(req, res) {
    const result = await prisma.notification.updateMany({
      where: { id: Number(req.params.id), userId: req.user.id }, data: { isRead: true }
    });
    if (!result.count) throw Object.assign(new Error('Notification not found'), { status: 404 });
    return apiResponse(res, { id: Number(req.params.id), isRead: true });
  },

  async markAllNotificationsRead(req, res) {
    const result = await prisma.notification.updateMany({ where: { userId: req.user.id, isRead: false }, data: { isRead: true } });
    return apiResponse(res, { count: result.count }, 'Notifications marked as read');
  },

  async deleteNotification(req, res) {
    const result = await prisma.notification.deleteMany({ where: { id: Number(req.params.id), userId: req.user.id } });
    if (!result.count) throw Object.assign(new Error('Notification not found'), { status: 404 });
    return apiResponse(res, null, 'Notification deleted');
  },

  async getProfile(req, res) {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    return apiResponse(res, publicUser(user));
  },

  async updateProfile(req, res) {
    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: { name: req.body.name, phone: req.body.phone, address: req.body.address }
    });
    return apiResponse(res, publicUser(user), 'Profile updated');
  },

  async uploadAvatar(req, res) {
    if (!req.file) throw Object.assign(new Error('Avatar file is required'), { status: 422 });
    const user = await prisma.user.update({
      where: { id: req.user.id }, data: { avatar: `/uploads/${req.file.filename}` }
    });
    return apiResponse(res, { avatar: user.avatar }, 'Avatar updated');
  },

  async changePassword(req, res) {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!(await bcrypt.compare(req.body.currentPassword, user.password))) {
      throw Object.assign(new Error('Current password is incorrect'), { status: 400 });
    }
    const password = await bcrypt.hash(req.body.newPassword, 12);
    await prisma.user.update({ where: { id: user.id }, data: { password } });
    return apiResponse(res, null, 'Password updated');
  },

  async getSettings(req, res) {
    const settings = await prisma.setting.upsert({
      where: { userId: req.user.id }, update: {}, create: { userId: req.user.id }
    });
    return apiResponse(res, settings);
  },

  async updateSettings(req, res) {
    const settings = await prisma.setting.upsert({
      where: { userId: req.user.id }, update: req.body, create: { ...req.body, userId: req.user.id }
    });
    return apiResponse(res, settings, 'Settings updated');
  },

  async calibrate(req, res) {
    const node = await ownedNode(req.user.id, req.body.nodeId);
    const payload = { calibration: { sensor: req.body.sensor, offset: req.body.offset } };
    await mqttService.publish(`jamur/node${node.nodeId}/pengaturan`, JSON.stringify(payload));
    return apiResponse(res, { nodeId: node.nodeId, ...payload }, 'Calibration command sent');
  },

  async mqttStatus(req, res) {
    return apiResponse(res, mqttService.getStatus());
  },

  async mqttMessages(req, res) {
    return apiResponse(res, mqttService.getMessages());
  },

  async publishMqttDebugTest(req, res) {
    const payload = JSON.stringify({ type: 'backend-debug-test', timestamp: new Date().toISOString() });
    await mqttService.publish('jamur/debug/test', payload);
    return apiResponse(res, { topic: 'jamur/debug/test', payload }, 'MQTT test message published');
  }
};

module.exports = controller;
