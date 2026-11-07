process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/jamur_monitor';
process.env.JWT_SECRET = 'unit-test-secret-value-at-least-32-characters';
process.env.NODE_ENV = 'test';

let mockNodes = [];
let mockLatestSensor = null;
const mockPublish = jest.fn().mockResolvedValue(undefined);

jest.mock('../src/config/database', () => ({
  prisma: {
    user: {
      findUnique: jest.fn(async ({ where }) => (
        [2, 9].includes(where.id) ? { id: where.id, role: 'user' } : null
      ))
    },
    node: {
      findMany: jest.fn(async ({ where }) => mockNodes.filter((node) => (
        node.nodeId <= where.nodeId.lte
        && (where.isActive !== true || node.isActive)
      ))),
      findUnique: jest.fn(async ({ where }) => mockNodes.find((node) => (
        where.nodeId !== undefined
          ? node.nodeId === where.nodeId
          : node.userId === where.userId_nodeId.userId
            && node.nodeId === where.userId_nodeId.nodeId
      )) || null),
      update: jest.fn(async ({ where, data }) => {
        const node = mockNodes.find((item) => item.id === where.id);
        Object.assign(node, data);
        return { ...node };
      })
    },
    sensorData: {
      findFirst: jest.fn(async () => mockLatestSensor)
    },
    log: { create: jest.fn(async ({ data }) => data) },
    $transaction: jest.fn(async (operations) => operations)
  }
}));

jest.mock('../src/services/mqtt.service', () => ({
  getLatest: jest.fn((nodeIds) => nodeIds.map((nodeId) => ({
    nodeId,
    temperature: null,
    humidity: null,
    soilMoisture: null,
    timestamp: null
  }))),
  publish: mockPublish,
  getStatus: jest.fn(() => ({})),
  getMessages: jest.fn(() => []),
  startMqtt: jest.fn(),
  setSocketServer: jest.fn()
}));

jest.mock('../src/services/influx.service', () => ({
  queryHistory: jest.fn().mockResolvedValue([]),
  writeSensor: jest.fn().mockResolvedValue(undefined)
}));

const jwt = require('jsonwebtoken');
const request = require('supertest');
const { app } = require('../src');

const createNodes = () => [
  { id: 1, userId: 2, nodeId: 1, mode: 'auto', isActive: true },
  { id: 2, userId: 2, nodeId: 2, mode: 'auto', isActive: true },
  { id: 3, userId: 2, nodeId: 3, mode: 'auto', isActive: true }
];

function tokenFor(userId) {
  return jwt.sign({ sub: userId, role: 'user' }, process.env.JWT_SECRET);
}

describe('shared node access and supported IDs', () => {
  beforeEach(() => {
    mockNodes = createNodes();
    mockLatestSensor = null;
    mockPublish.mockClear();
  });

  test('lists Node 1–2 for any authenticated account', async () => {
    const response = await request(app)
      .get('/api/nodes')
      .set('Authorization', `Bearer ${tokenFor(9)}`);

    expect(response.status).toBe(200);
    expect(response.body.data.map(({ nodeId }) => nodeId)).toEqual([1, 2]);
  });

  test.each([1, 2])('allows any authenticated account to change Node %i mode', async (nodeId) => {
    const response = await request(app)
      .post(`/api/nodes/${nodeId}/mode`)
      .set('Authorization', `Bearer ${tokenFor(9)}`)
      .send({ mode: 'manual' });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ nodeId, userId: 2, mode: 'manual' });
    expect(mockPublish).toHaveBeenCalledWith(`jamur/node${nodeId}/mode`, 'manual');
  });

  test('allows any authenticated account to read shared node details and sensors', async () => {
    const token = tokenFor(9);
    const [list, detail, sensor] = await Promise.all([
      request(app).get('/api/nodes').set('Authorization', `Bearer ${token}`),
      request(app).get('/api/nodes/1').set('Authorization', `Bearer ${token}`),
      request(app).get('/api/sensor/1/current').set('Authorization', `Bearer ${token}`)
    ]);

    expect(list.status).toBe(200);
    expect(list.body.data.map(({ nodeId }) => nodeId)).toEqual([1, 2]);
    expect(detail.status).toBe(200);
    expect(detail.body.data.nodeId).toBe(1);
    expect(sensor.status).toBe(200);
    expect(sensor.body.data.nodeId).toBe(1);
  });

  test('returns the latest persisted sensor values instead of node targets', async () => {
    mockLatestSensor = {
      soil_moisture: 9,
      temperature: 24.5,
      humidity: 81,
      battery_voltage: 3.87,
      battery_percent: 72,
      createdAt: new Date('2026-11-07T06:00:00.000Z')
    };
    const response = await request(app)
      .get('/api/sensor/1/current')
      .set('Authorization', `Bearer ${tokenFor(9)}`);

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      nodeId: 1,
      soilMoisture: 9,
      temperature: 24.5,
      humidity: 81,
      batteryVoltage: 3.87,
      batteryPercent: 72,
      timestamp: '2026-11-07T06:00:00.000Z'
    });
  });

  test('allows any authenticated account to control the shared master pump', async () => {
    const response = await request(app)
      .post('/api/control/pompa')
      .set('Authorization', `Bearer ${tokenFor(9)}`)
      .send({ duration: 5 });

    expect(response.status).toBe(200);
    expect(mockPublish).toHaveBeenCalledWith('jamur/pompa/perintah', 5);
  });

  test('requires an administrator to create new accounts', async () => {
    const response = await request(app)
      .post('/api/auth/register')
      .set('Authorization', `Bearer ${tokenFor(9)}`)
      .send({
        email: 'new-user@example.com',
        name: 'New User',
        password: 'password123'
      });

    expect(response.status).toBe(403);
    expect(response.body.message).toBe('Administrator access required');
  });

  test('keeps node configuration edits restricted to the owner', async () => {
    const response = await request(app)
      .put('/api/nodes/1')
      .set('Authorization', `Bearer ${tokenFor(9)}`)
      .send({ name: 'Shared edit' });

    expect(response.status).toBe(404);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  test('rejects Node 3 even when a row exists in the database', async () => {
    const response = await request(app)
      .post('/api/nodes/3/mode')
      .set('Authorization', `Bearer ${tokenFor(9)}`)
      .send({ mode: 'manual' });

    expect(response.status).toBe(422);
    expect(mockPublish).not.toHaveBeenCalled();
  });
});
