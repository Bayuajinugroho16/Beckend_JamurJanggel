const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { prisma } = require('../config/database');
const logger = require('../utils/logger');
const { setSocketServer } = require('../services/notification.service');
const { MAX_NODE_ID } = require('../config/nodes');

function initializeSocket(server) {
  const io = new Server(server, {
    cors: { origin: env.CORS_ORIGIN === '*' ? '*' : env.CORS_ORIGIN.split(',').map((origin) => origin.trim()), methods: ['GET', 'POST'] }
  });

  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.headers.authorization?.replace(/^Bearer\s+/i, '');
      if (!token) return next(new Error('Authentication required'));
      const payload = jwt.verify(token, env.JWT_SECRET);
      socket.data.userId = Number(payload.sub);
      next();
    } catch (error) {
      next(new Error('Invalid or expired authentication token'));
    }
  });

  io.on('connection', (socket) => {
    socket.join(`user:${socket.data.userId}`);
    socket.on('subscribe:node', async ({ nodeId } = {}, acknowledge = () => {}) => {
      const id = Number(nodeId);
      if (!Number.isInteger(id) || id < 1 || id > MAX_NODE_ID) return acknowledge({ success: false, message: 'Invalid nodeId' });
      try {
        const node = await prisma.node.findUnique({ where: { nodeId: id } });
        if (!node || !node.isActive) return acknowledge({ success: false, message: 'Node not found' });
        socket.join(`node:${id}`);
        acknowledge({ success: true });
      } catch (error) {
        logger.error('Socket node subscription failed', { message: error.message, userId: socket.data.userId });
        acknowledge({ success: false, message: 'Could not subscribe to node' });
      }
    });
    socket.on('unsubscribe:node', ({ nodeId } = {}, acknowledge = () => {}) => {
      const id = Number(nodeId);
      if (!Number.isInteger(id) || id < 1 || id > MAX_NODE_ID) return acknowledge({ success: false, message: 'Invalid nodeId' });
      socket.leave(`node:${id}`);
      acknowledge({ success: true });
    });
  });

  setSocketServer(io);
  return io;
}

module.exports = { initializeSocket };
