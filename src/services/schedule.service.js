const cron = require('node-cron');
const { prisma } = require('../config/database');
const mqttService = require('./mqtt.service');
const logger = require('../utils/logger');
const { MAX_NODE_ID } = require('../config/nodes');

function startScheduleWorker(io) {
  return cron.schedule('* * * * *', async () => {
    try {
      const now = new Date();
      const wibOffset = 7 * 60 * 60 * 1000;
const wibTime = new Date(Date.now() + wibOffset);
const time = `${String(wibTime.getHours()).padStart(2, '0')}:${String(wibTime.getMinutes()).padStart(2, '0')}`;
const day = wibTime.getDay();
      const schedules = await prisma.schedule.findMany({
        where: { isActive: true, time },
        include: { node: true }
      });

      for (const schedule of schedules) {
        if (
          schedule.days[day] !== '1' ||
          !schedule.node.isActive ||
          schedule.node.mode !== 'auto' ||
          schedule.node.nodeId > MAX_NODE_ID
        ) continue;
        try {
        await mqttService.publish('jamur/pompa/perintah', schedule.duration);
        await prisma.log.create({
          data: { nodeId: schedule.nodeId, action: 'water', duration: schedule.duration, source: 'schedule' }
        });
        io.to(`node:${schedule.node.nodeId}`).emit('schedule:triggered', {
          nodeId: schedule.node.nodeId, scheduleId: schedule.id, duration: schedule.duration
        });
        io.to(`node:${schedule.node.nodeId}`).emit('relay:status', {
          nodeId: schedule.node.nodeId, isWatering: true, duration: schedule.duration
        });
        } catch (error) {
          logger.error('Scheduled watering failed', { scheduleId: schedule.id, message: error.message });
        }
      }
    } catch (error) {
      logger.error('Schedule worker failed', { message: error.message });
    }
  });
}

module.exports = { startScheduleWorker };
