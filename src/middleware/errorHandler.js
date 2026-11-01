const logger = require('../utils/logger');

function notFound(req, res) {
  res.status(404).json({
    success: false,
    message: 'Endpoint not found',
    errors: [],
    timestamp: new Date().toISOString()
  });
}

function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);

  const prismaStatus = {
    P2002: 409,
    P2025: 404,
    P2003: 400
  }[error.code];
  const status = Number(error.status || error.statusCode || prismaStatus) ||
    (error.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
  if (status >= 500) logger.error('Request failed', { method: req.method, path: req.originalUrl, message: error.message });
  res.status(status).json({
    success: false,
    message: status >= 500 && process.env.NODE_ENV === 'production' ? 'Internal server error' : error.message,
    errors: error.details || [],
    timestamp: new Date().toISOString()
  });
}

module.exports = { notFound, errorHandler };
