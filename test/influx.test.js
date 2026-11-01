process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/jamur_monitor';
process.env.JWT_SECRET = 'unit-test-secret-value-at-least-32-characters';
process.env.NODE_ENV = 'test';

jest.mock('../src/config/influxdb', () => ({
  configured: true,
  writeApi: {
    writePoint: jest.fn(),
    flush: jest.fn().mockResolvedValue()
  },
  queryApi: null
}));

const influx = require('../src/config/influxdb');
const { writeSensor } = require('../src/services/influx.service');

describe('InfluxDB sensor writes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('converts ISO sensor timestamps to Date before line-protocol serialization', async () => {
    await writeSensor({
      nodeId: 1,
      userId: 2,
      temperature: 25.5,
      humidity: 80,
      soilMoisture: 60,
      batteryVoltage: 3.87,
      batteryPercent: 72,
      timestamp: '2026-10-15T22:35:46.632Z'
    });

    expect(influx.writeApi.writePoint).toHaveBeenCalledTimes(1);
    const point = influx.writeApi.writePoint.mock.calls[0][0];
    const serialized = point.toLineProtocol({
      convertTime(value) {
        expect(value).toBeInstanceOf(Date);
        return String(value.getTime());
      }
    });

    expect(serialized).toContain('temperature=25.5');
    expect(serialized).toContain('battery_voltage=3.87');
    expect(serialized).toContain('battery_percent=72');
    expect(serialized).toMatch(/ \d+$/);
    expect(serialized).not.toContain('2026-10-15T');
    expect(influx.writeApi.flush).toHaveBeenCalledTimes(1);
  });

  test('rejects malformed sensor timestamps before writing', async () => {
    await expect(writeSensor({
      nodeId: 1,
      userId: 2,
      temperature: 25,
      timestamp: 'not-a-date'
    })).rejects.toMatchObject({ message: 'Sensor timestamp must be a valid date', status: 422 });

    expect(influx.writeApi.writePoint).not.toHaveBeenCalled();
  });
});
