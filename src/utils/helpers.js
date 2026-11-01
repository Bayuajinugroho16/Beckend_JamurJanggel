function apiResponse(res, data, message = 'OK', status = 200) {
  return res.status(status).json({ success: true, message, data, timestamp: new Date().toISOString() });
}

function apiError(res, message, status = 400, errors = []) {
  return res.status(status).json({ success: false, message, errors, timestamp: new Date().toISOString() });
}

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

module.exports = { apiResponse, apiError, asyncHandler };
