const { prisma } = require('../config/database');
const logger = require('../utils/logger');

let io;

function setSocketServer(socketServer) {
  io = socketServer;
}

async function createNotification({ userId, title, message, type = 'info' }) {
  const notification = await prisma.notification.create({
    data: { userId, title, message, type }
  });
  if (io) io.to(`user:${userId}`).emit('notification:new', {
    id: notification.id,
    title: notification.title,
    message: notification.message,
    type: notification.type,
    timestamp: notification.createdAt
  });
  return notification;
}

async function notifySensorThreshold(node, reading) {
  const violations = [];
  if (Number.isFinite(reading.temperature) && reading.temperature > node.targetTemp + 3) {
    violations.push(`Suhu ${reading.temperature}°C melebihi target ${node.targetTemp}°C`);
  }
  if (Number.isFinite(reading.humidity) && reading.humidity < node.targetRh - 10) {
    violations.push(`Kelembapan udara ${reading.humidity}% di bawah target ${node.targetRh}%`);
  }
  if (Number.isFinite(reading.soilMoisture) && reading.soilMoisture < node.targetSoil - 10) {
    violations.push(`Kelembapan tanah ${reading.soilMoisture}% di bawah target ${node.targetSoil}%`);
  }

  for (const message of violations) {
    try {
      const recent = await prisma.notification.findFirst({
        where: {
          userId: node.userId,
          title: `Peringatan ${node.name}`,
          isRead: false,
          createdAt: { gte: new Date(Date.now() - 15 * 60 * 1000) }
        },
        select: { id: true }
      });
      if (recent) continue;
      await createNotification({ userId: node.userId, title: `Peringatan ${node.name}`, message, type: 'warning' });
    } catch (error) {
      logger.error('Could not create sensor threshold notification', { nodeId: node.nodeId, message: error.message });
    }
  }
}

module.exports = { setSocketServer, createNotification, notifySensorThreshold };
