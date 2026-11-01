process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/jamur_monitor';
process.env.JWT_SECRET = 'unit-test-secret-value-at-least-32-characters';
process.env.NODE_ENV = 'test';

jest.mock('../src/config/database', () => ({
  prisma: {
    user: { findUnique: jest.fn() },
    node: { findMany: jest.fn(), findUnique: jest.fn() },
    log: { create: jest.fn() },
    $transaction: jest.fn()
  },
  connectDatabase: jest.fn()
}));

jest.mock('../src/services/mqtt.service', () => ({
  startMqtt: jest.fn(),
  setSocketServer: jest.fn(),
  publish: jest.fn(),
  getLatest: jest.fn(() => []),
  getStatus: jest.fn(() => ({ connected: false, messages: [] })),
  getMessages: jest.fn(() => [])
}));

jest.mock('../src/services/influx.service', () => ({
  writeSensor: jest.fn(),
  queryHistory: jest.fn()
}));

const jwt = require('jsonwebtoken');
const request = require('supertest');
const { app } = require('../src');
const { prisma } = require('../src/config/database');
const mqttService = require('../src/services/mqtt.service');
const { queryHistory } = require('../src/services/influx.service');

const token = jwt.sign({ sub: 1, role: 'user' }, process.env.JWT_SECRET);
const authorization = { Authorization: `Bearer ${token}` };

describe('master pump and battery history API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.user.findUnique.mockResolvedValue({
      id: 1,
      email: 'test@example.com',
      name: 'Test',
      role: 'user'
    });
    prisma.node.findMany.mockResolvedValue([]);
    prisma.node.findUnique.mockResolvedValue({ id: 10, nodeId: 1 });
    prisma.log.create.mockResolvedValue({});
    prisma.$transaction.mockImplementation((operations) => Promise.all(operations));
    mqttService.publish.mockResolvedValue();
  });

  test('publishes the duration once to the master pump topic and logs active nodes', async () => {
    prisma.node.findMany.mockResolvedValue([
      { id: 10, nodeId: 1 },
      { id: 11, nodeId: 2 }
    ]);

    const response = await request(app)
      .post('/api/control/pompa')
      .set(authorization)
      .send({ duration: 7 });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      isWatering: true,
      duration: 7,
      nodeCount: 2
    });
    expect(mqttService.publish).toHaveBeenCalledTimes(1);
    expect(mqttService.publish).toHaveBeenCalledWith('jamur/pompa/perintah', 7);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.log.create).toHaveBeenCalledTimes(2);
  });

  test('publishes zero to stop the master pump', async () => {
    const response = await request(app)
      .post('/api/control/pompa/stop')
      .set(authorization);

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      isWatering: false,
      duration: 0
    });
    expect(mqttService.publish).toHaveBeenCalledWith('jamur/pompa/perintah', 0);
  });

  test('rejects invalid pump durations before publishing', async () => {
    const response = await request(app)
      .post('/api/control/pompa')
      .set(authorization)
      .send({ duration: 0 });

    expect(response.status).toBe(422);
    expect(mqttService.publish).not.toHaveBeenCalled();
  });

  test('requires authentication for pump controls', async () => {
    const response = await request(app)
      .post('/api/control/pompa')
      .send({ duration: 5 });

    expect(response.status).toBe(401);
    expect(mqttService.publish).not.toHaveBeenCalled();
  });

  test('returns only battery columns from InfluxDB history', async () => {
    const timestamp = '2026-10-28T07:00:00.000Z';
    queryHistory.mockResolvedValue([
      { timestamp, temperature: 24, batteryVoltage: 3.87, batteryPercent: 72 },
      { timestamp, temperature: 25, batteryVoltage: null, batteryPercent: null }
    ]);

    const response = await request(app)
      .get('/api/sensor/1/battery')
      .query({
        from: '2026-10-28T00:00:00.000Z',
        to: '2026-10-28T08:00:00.000Z'
      })
      .set(authorization);

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([
      { timestamp, batteryVoltage: 3.87, batteryPercent: 72 }
    ]);
  });
});
