process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/jamur_monitor';
process.env.JWT_SECRET = 'unit-test-secret-value-at-least-32-characters';
process.env.NODE_ENV = 'test';

const { EventEmitter } = require('events');
const mqttService = require('../src/services/mqtt.service');

describe('MQTT subscriptions', () => {
  test('uses compact topic filters to subscribe to node telemetry after connect', () => {
    const client = new EventEmitter();
    client.subscribe = jest.fn((topics, options, callback) => callback(null));

    mqttService.startMqtt(client, null);
    expect(client.subscribe).not.toHaveBeenCalled();

    client.emit('connect');

    expect(client.subscribe).toHaveBeenCalledWith(
      [
        'jamur/+/soil', 'jamur/+/suhu', 'jamur/+/rh',
        'jamur/+/battery', 'jamur/+/battery_percent', 'jamur/+/status',
        'jamur/notifikasi', 'jamur/debug/test'
      ],
      { qos: 1 },
      expect.any(Function)
    );
  });

  test('logs topics rejected by the broker', () => {
    const client = new EventEmitter();
    const logger = require('../src/utils/logger');
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});
    client.subscribe = jest.fn((topics, options, callback) => callback(
      Object.assign(new Error('Subscribe error: Unspecified error'), {
        packet: { granted: topics.map((_, index) => index === 2 ? 0x80 : 1) }
      }),
      topics.map((topic) => ({ topic }))
    ));

    mqttService.startMqtt(client, null);
    client.emit('connect');

    expect(errorSpy).toHaveBeenCalledWith('MQTT subscription failed', {
      message: 'Subscribe error: Unspecified error',
      rejectedTopics: [{ topic: 'jamur/+/rh', reasonCode: 0x80 }]
    });
    errorSpy.mockRestore();
  });

  test('updates latest battery telemetry from per-node MQTT topics', async () => {
    const { prisma } = require('../src/config/database');
    const nodeQuery = jest.spyOn(prisma.node, 'findMany').mockResolvedValue([]);
    const client = new EventEmitter();
    client.subscribe = jest.fn();
    mqttService.startMqtt(client, null);

    client.emit('message', 'jamur/node1/battery', Buffer.from('3.87'));
    client.emit('message', 'jamur/node1/battery_percent', Buffer.from('72'));
    await new Promise((resolve) => setImmediate(resolve));

    expect(mqttService.getLatest([1])[0]).toMatchObject({
      batteryVoltage: 3.87,
      batteryPercent: 72
    });
    nodeQuery.mockRestore();
  });

  test('persists each individual sensor topic as the latest known PostgreSQL snapshot', async () => {
    const { prisma } = require('../src/config/database');
    const nodeQuery = jest.spyOn(prisma.node, 'findMany').mockResolvedValue([{
      id: 1,
      nodeId: 1,
      userId: 2,
      mode: 'manual',
      isActive: true,
      targetTemp: 25,
      targetRh: 0,
      targetSoil: 0
    }]);
    const sensorCreate = jest.spyOn(prisma.sensorData, 'create').mockResolvedValue({});
    const client = new EventEmitter();
    client.subscribe = jest.fn();
    mqttService.startMqtt(client, null);

    for (const [field, value] of [
      ['soil', '9'],
      ['suhu', '25.5'],
      ['rh', '80'],
      ['battery', '3.87'],
      ['battery_percent', '72']
    ]) {
      client.emit(`message`, `jamur/node1/${field}`, Buffer.from(value));
      await new Promise((resolve) => setImmediate(resolve));
    }

    expect(sensorCreate).toHaveBeenCalledTimes(5);
    expect(sensorCreate).toHaveBeenLastCalledWith({
      data: expect.objectContaining({
        nodeId: 1,
        soil_moisture: 9,
        temperature: 25.5,
        humidity: 80,
        battery_voltage: 3.87,
        battery_percent: 72,
        createdAt: expect.any(Date)
      })
    });
    sensorCreate.mockRestore();
    nodeQuery.mockRestore();
  });

  test('records and logs received MQTT messages for the debug endpoints', () => {
    const client = new EventEmitter();
    client.subscribe = jest.fn();
    const logger = require('../src/utils/logger');
    const logSpy = jest.spyOn(logger, 'info').mockImplementation(() => {});
    const existingMessages = mqttService.getMessages();

    mqttService.startMqtt(client, null);
    client.emit('message', 'jamur/debug/test', Buffer.from('diagnostic'));

    expect(mqttService.getStatus().connected).toBe(false);
    expect(mqttService.getMessages()).toHaveLength(Math.min(existingMessages.length + 1, 10));
    expect(mqttService.getMessages().at(-1)).toMatchObject({
      topic: 'jamur/debug/test',
      payload: 'diagnostic'
    });
    expect(logSpy).toHaveBeenCalledWith('MQTT message received', {
      topic: 'jamur/debug/test',
      payload: 'diagnostic'
    });

    logSpy.mockRestore();
  });

  test('ignores sensor messages from nodes above two', async () => {
    const client = new EventEmitter();
    client.subscribe = jest.fn();
    mqttService.startMqtt(client, null);

    client.emit('message', 'jamur/node3/soil', Buffer.from('42'));
    await new Promise((resolve) => setImmediate(resolve));

    expect(mqttService.getLatest([3])[0]).toMatchObject({
      soilMoisture: null,
      timestamp: null
    });
  });

  test('publishes through the connected broker and rejects when disconnected', async () => {
    const client = new EventEmitter();
    client.connected = true;
    client.subscribe = jest.fn();
    client.publish = jest.fn((topic, payload, options, callback) => callback(null));
    mqttService.startMqtt(client, null);

    await expect(mqttService.publish('jamur/debug/test', 'ok')).resolves.toBeUndefined();
    expect(client.publish).toHaveBeenCalledWith(
      'jamur/debug/test',
      'ok',
      { qos: 1 },
      expect.any(Function)
    );

    client.connected = false;
    expect(() => mqttService.publish('jamur/debug/test', 'ok')).toThrow(expect.objectContaining({
      message: 'MQTT broker is not connected',
      status: 503
    }));
  });
});
