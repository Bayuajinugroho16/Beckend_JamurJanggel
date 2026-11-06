process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/jamur_monitor';
process.env.JWT_SECRET = 'unit-test-secret-value-at-least-32-characters';
process.env.NODE_ENV = 'test';

const { EventEmitter } = require('events');
const mqttService = require('../src/services/mqtt.service');

describe('MQTT subscriptions', () => {
  test('subscribes only to the first two nodes after connect', () => {
    const client = new EventEmitter();
    client.subscribe = jest.fn((topics, options, callback) => callback(null));

    mqttService.startMqtt(client, null);
    expect(client.subscribe).not.toHaveBeenCalled();

    client.emit('connect');

    expect(client.subscribe).toHaveBeenCalledWith(
      [
        'jamur/node1/soil', 'jamur/node1/suhu', 'jamur/node1/rh',
        'jamur/node1/battery', 'jamur/node1/battery_percent', 'jamur/node1/status',
        'jamur/node2/soil', 'jamur/node2/suhu', 'jamur/node2/rh',
        'jamur/node2/battery', 'jamur/node2/battery_percent', 'jamur/node2/status',
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
      rejectedTopics: [{ topic: 'jamur/node1/rh', reasonCode: 0x80 }]
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
