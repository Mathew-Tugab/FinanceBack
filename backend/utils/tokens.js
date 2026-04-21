const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const ACCESS_TOKEN_COOKIE = 'accessToken';
const REFRESH_TOKEN_COOKIE = 'refreshToken';

function getAccessTokenOptions() {
  const isProd = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    // 'none' required in production: frontend and backend are on different origins
    sameSite: isProd ? 'none' : 'strict',
    secure: isProd,
    maxAge: Number(process.env.ACCESS_TOKEN_COOKIE_MS || 15 * 60 * 1000),
  };
}

function getRefreshTokenOptions() {
  const isProd = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    sameSite: isProd ? 'none' : 'strict',
    secure: isProd,
    maxAge: Number(process.env.REFRESH_TOKEN_COOKIE_MS || 7 * 24 * 60 * 60 * 1000),
  };
}

function signAccessToken(user) {
  const payload = {
    sub: user._id.toString(),
    role: user.role,
    username: user.username,
    jti: crypto.randomUUID(),
    type: 'access',
  };

  return jwt.sign(payload, process.env.JWT_ACCESS_SECRET, {
    expiresIn: process.env.JWT_ACCESS_EXPIRES || '15m',
  });
}

function signRefreshToken(user, family) {
  const payload = {
    sub: user._id.toString(),
    family,
    type: 'refresh',
  };

  return jwt.sign(payload, process.env.JWT_REFRESH_SECRET, {
    expiresIn: process.env.JWT_REFRESH_EXPIRES || '7d',
  });
}

function verifyAccessToken(token) {
  return jwt.verify(token, process.env.JWT_ACCESS_SECRET);
}

function verifyRefreshToken(token) {
  return jwt.verify(token, process.env.JWT_REFRESH_SECRET);
}

function decodeToken(token) {
  return jwt.decode(token);
}

module.exports = {
  ACCESS_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
  getAccessTokenOptions,
  getRefreshTokenOptions,
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  decodeToken,
};
