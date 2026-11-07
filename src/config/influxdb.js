const { InfluxDB } = require('@influxdata/influxdb-client');
const env = require('./env');

const configured = Boolean(env.INFLUX_URL && env.INFLUX_TOKEN && env.INFLUX_ORG && env.INFLUX_BUCKET);
const client = configured ? new InfluxDB({ url: env.INFLUX_URL, token: env.INFLUX_TOKEN }) : null;

module.exports = {
  configured,
  client,
  writeApi: client ? client.getWriteApi(env.INFLUX_ORG, env.INFLUX_BUCKET, 'ms') : null,
  queryApi: client ? client.getQueryApi(env.INFLUX_ORG) : null
};
