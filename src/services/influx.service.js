const { Point } = require('@influxdata/influxdb-client');
const influx = require('../config/influxdb');
const env = require('../config/env');

function ensureConfigured() {
  if (!influx.configured) {
    throw Object.assign(new Error('InfluxDB is not configured'), { status: 503 });
  }
}

async function writeSensor({
  nodeId,
  userId,
  temperature,
  humidity,
  soilMoisture,
  batteryVoltage,
  batteryPercent,
  timestamp
}) {
  ensureConfigured();
  const pointTimestamp = timestamp == null
    ? new Date()
    : timestamp instanceof Date
      ? timestamp
      : new Date(timestamp);
  if (Number.isNaN(pointTimestamp.getTime())) {
    throw Object.assign(new Error('Sensor timestamp must be a valid date'), { status: 422 });
  }

  const point = new Point('sensor_data')
    .tag('node_id', String(nodeId))
    .tag('user_id', String(userId))
    .timestamp(pointTimestamp);

  if (Number.isFinite(temperature)) point.floatField('temperature', temperature);
  if (Number.isFinite(humidity)) point.floatField('humidity', humidity);
  if (Number.isFinite(soilMoisture)) point.floatField('soil_moisture', soilMoisture);
  if (Number.isFinite(batteryVoltage)) point.floatField('battery_voltage', batteryVoltage);
  if (Number.isFinite(batteryPercent)) point.floatField('battery_percent', batteryPercent);
  influx.writeApi.writePoint(point);
  await influx.writeApi.flush();
}

async function queryHistory({ nodeId, from, to, aggregate = 'mean', interval = '5m' }) {
  ensureConfigured();
  const aggregators = { mean: 'mean', max: 'max', min: 'min' };
  const windows = new Set(['5m', '1h', '1d']);
  if (!aggregators[aggregate] || !windows.has(interval)) {
    throw Object.assign(new Error('Invalid aggregate or interval'), { status: 422 });
  }

  const flux = `
from(bucket: "${env.INFLUX_BUCKET}")
  |> range(start: ${new Date(from).toISOString()}, stop: ${new Date(to).toISOString()})
  |> filter(fn: (r) => r._measurement == "sensor_data" and r.node_id == "${nodeId}")
  |> aggregateWindow(every: ${interval}, fn: ${aggregators[aggregate]}, createEmpty: false)
  |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")
  |> sort(columns: ["_time"])
`;
  const rows = await new Promise((resolve, reject) => {
    const result = [];
    influx.queryApi.queryRows(flux, {
      next(row, tableMeta) {
        const value = tableMeta.toObject(row);
        result.push({
          timestamp: value._time,
          temperature: value.temperature ?? null,
          humidity: value.humidity ?? null,
          soilMoisture: value.soil_moisture ?? null,
          batteryVoltage: value.battery_voltage ?? null,
          batteryPercent: value.battery_percent ?? null
        });
      },
      error: reject,
      complete: () => resolve(result)
    });
  });
  return rows;
}

module.exports = { writeSensor, queryHistory };
