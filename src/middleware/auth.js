const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { prisma } = require('../config/database');

function tokenFromRequest(req) {
  const header = req.headers.authorization;
  return header && header.startsWith('Bearer ') ? header.slice(7) : null;
}

async function authenticate(req, res, next) {
  try {
    const token = tokenFromRequest(req);
    if (!token) return res.status(401).json({ success: false, message: 'Authentication required', errors: [], timestamp: new Date().toISOString() });
    const payload = jwt.verify(token, env.JWT_SECRET);
    const user = await prisma.user.findUnique({ where: { id: payload.sub }, select: { id: true, email: true, name: true, role: true } });
    if (!user) return res.status(401).json({ success: false, message: 'Invalid authentication token', errors: [], timestamp: new Date().toISOString() });
    req.user = user;
    next();
  } catch (error) {
    next(error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError' || error.name === 'NotBeforeError'
      ? Object.assign(new Error('Invalid or expired authentication token'), { status: 401 })
      : error);
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({
      success: false,
      message: 'Administrator access required',
      errors: [],
      timestamp: new Date().toISOString()
    });
  }
  next();
}

module.exports = { authenticate, requireAdmin, tokenFromRequest };
