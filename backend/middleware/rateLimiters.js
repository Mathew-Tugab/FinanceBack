const rateLimit = require('express-rate-limit');

const authLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.LOGIN_RATE_LIMIT_MAX || 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: 'Too many login attempts. Please try again later.',
  },
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: Number(process.env.REGISTER_RATE_LIMIT_MAX || 5),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: 'Too many registration attempts. Please try again later.',
  },
});

const verifyEmailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.VERIFY_EMAIL_RATE_LIMIT_MAX || 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: 'Too many verification attempts. Please try again later.',
  },
});

const formSyncReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.FORM_SYNC_READ_RATE_LIMIT_MAX || 30),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: 'Too many form-sync read requests. Please try again shortly.',
  },
});

const formSyncWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.FORM_SYNC_WRITE_RATE_LIMIT_MAX || 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: 'Too many form-sync sync requests. Please try again later.',
  },
});

const generalApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.GENERAL_RATE_LIMIT_MAX || 500),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: 'Too many requests. Please try again later.',
  },
});

module.exports = {
  authLoginLimiter,
  registerLimiter,
  verifyEmailLimiter,
  formSyncReadLimiter,
  formSyncWriteLimiter,
  generalApiLimiter,
};
