const { PrismaClient } = require('@prisma/client');
const logger = require('../utils/logger');

const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error']
});

async function connectDatabase() {
  await prisma.$connect();
  logger.info('Connected to PostgreSQL');
}

module.exports = { prisma, connectDatabase };
