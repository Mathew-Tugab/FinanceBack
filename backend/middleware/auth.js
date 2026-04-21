const User = require('../models/User');
const TokenBlacklist = require('../models/TokenBlacklist');
const { verifyAccessToken, ACCESS_TOKEN_COOKIE } = require('../utils/tokens');
const { hashToken } = require('../utils/crypto');

async function authenticate(req, res, next) {
  try {
    const token = req.cookies[ACCESS_TOKEN_COOKIE];

    if (!token) {
      return res.status(401).json({ message: 'Authentication required' });
    }

    const tokenHash = hashToken(token);
    const blacklisted = await TokenBlacklist.findOne({ tokenHash }).lean();
    if (blacklisted) {
      return res.status(401).json({ message: 'Session is invalidated' });
    }

    const payload = verifyAccessToken(token);
    const user = await User.findById(payload.sub).select('-password').lean();

    if (!user) {
      return res.status(401).json({ message: 'User not found' });
    }

    req.user = {
      id: user._id.toString(),
      username: user.username,
      role: user.role,
      isApproved: user.isApproved,
    };

    return next();
  } catch (error) {
    return res.status(401).json({ message: 'Invalid or expired access token' });
  }
}

async function optionalAuthenticate(req, res, next) {
  try {
    const token = req.cookies[ACCESS_TOKEN_COOKIE];
    if (!token) return next();

    const tokenHash = hashToken(token);
    const blacklisted = await TokenBlacklist.findOne({ tokenHash }).lean();
    if (blacklisted) return next();

    const payload = verifyAccessToken(token);
    const user = await User.findById(payload.sub).select('-password').lean();
    if (!user) return next();

    req.user = {
      id: user._id.toString(),
      username: user.username,
      role: user.role,
      isApproved: user.isApproved,
    };

    return next();
  } catch {
    return next();
  }
}

module.exports = {
  optionalAuthenticate,
  authenticate,
};
