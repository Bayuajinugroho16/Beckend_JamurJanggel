const Joi = require('joi');
const dotenv = require('dotenv');

dotenv.config();

const schema = Joi.object({
  PORT: Joi.number().integer().min(1).max(65535).default(3000),
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  DATABASE_URL: Joi.string().uri({ scheme: ['postgres', 'postgresql'] }).required(),
  JWT_SECRET: Joi.string().min(32).required(),
  JWT_EXPIRES_IN: Joi.string().default('7d'),
  CORS_ORIGIN: Joi.string().default('*'),
  INFLUX_URL: Joi.string().allow('').default(''),
  INFLUX_TOKEN: Joi.string().allow('').default(''),
  INFLUX_ORG: Joi.string().allow('').default(''),
  INFLUX_BUCKET: Joi.string().default('jamur_monitor'),
  MQTT_HOST: Joi.string().allow('').default(''),
  MQTT_PORT: Joi.number().integer().min(1).max(65535).default(8883),
  MQTT_USERNAME: Joi.string().allow('').default(''),
  MQTT_PASSWORD: Joi.string().allow('').default(''),
  MQTT_CLIENT_ID: Joi.string().default('jamur-monitor-backend'),
  UPLOAD_DIR: Joi.string().default('uploads'),
  MAX_AVATAR_SIZE_MB: Joi.number().positive().default(5),
  SMTP_HOST: Joi.string().allow('').default(''),
  SMTP_PORT: Joi.number().integer().min(1).max(65535).default(587),
  SMTP_SECURE: Joi.boolean().truthy('true').falsy('false').default(false),
  SMTP_USER: Joi.string().allow('').default(''),
  SMTP_PASSWORD: Joi.string().allow('').default(''),
  SMTP_FROM: Joi.string().allow('').default(''),
  FRONTEND_RESET_URL: Joi.string().allow('').default('')
}).unknown(true);

const { value, error } = schema.validate(process.env, { convert: true });
if (error) {
  throw new Error(`Invalid environment configuration: ${error.message}`);
}

module.exports = Object.freeze(value);
