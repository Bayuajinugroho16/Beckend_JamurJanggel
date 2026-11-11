process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/jamur_monitor';
process.env.JWT_SECRET = 'unit-test-secret-value-at-least-32-characters';
process.env.NODE_ENV = 'test';

const cron = require('node-cron');
jest.mock('node-cron', () => ({
  schedule: jest.fn((expression, callback) => ({ expression, callback, stop: jest.fn() }))
}));
jest.mock('../src/config/database', () => ({
  prisma: {
    schedule: { findMany: jest.fn() },
    log: { create: jest.fn() }
  }
}));
jest.mock('../src/services/mqtt.service', () => ({
  publish: jest.fn()
}));

const { prisma } = require('../src/config/database');
const mqttService = require('../src/services/mqtt.service');
const { startScheduleWorker } = require('../src/services/schedule.service');

describe('schedule worker mode handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.schedule.findMany.mockResolvedValue([]);
    prisma.log.create.mockResolvedValue({});
    mqttService.publish.mockResolvedValue();
  });

  test('does not publish scheduled watering for a manual-mode node', async () => {
    const now = new Date();
    const days = Array(now.getDay()).fill('0').join('') + '1' + Array(6 - now.getDay()).fill('0').join('');
    prisma.schedule.findMany.mockResolvedValue([{
      id: 1,
      nodeId: 1,
      duration: 5,
      days,
      node: { nodeId: 1, isActive: true, mode: 'manual' }
    }]);

    startScheduleWorker({ to: jest.fn() });
    await cron.schedule.mock.calls[0][1]();

    expect(mqttService.publish).not.toHaveBeenCalled();
    expect(prisma.log.create).not.toHaveBeenCalled();
  });

  test('continues scheduled watering for an auto-mode node', async () => {
    const now = new Date();
    const days = Array(now.getDay()).fill('0').join('') + '1' + Array(6 - now.getDay()).fill('0').join('');
    const io = { to: jest.fn(() => ({ emit: jest.fn() })) };
    prisma.schedule.findMany.mockResolvedValue([{
      id: 2,
      nodeId: 1,
      duration: 5,
      days,
      node: { nodeId: 1, isActive: true, mode: 'auto' }
    }]);

    startScheduleWorker(io);
    await cron.schedule.mock.calls[0][1]();

    expect(mqttService.publish).toHaveBeenCalledWith('jamur/pompa/perintah', 5);
    expect(prisma.log.create).toHaveBeenCalledWith({
      data: { nodeId: 1, action: 'water', duration: 5, source: 'schedule' }
    });
  });
});
