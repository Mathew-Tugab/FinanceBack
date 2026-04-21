const crypto = require('crypto');
const User = require('../models/User');
const RefreshToken = require('../models/RefreshToken');
const TokenBlacklist = require('../models/TokenBlacklist');
const AuditLog = require('../models/AuditLog');
const { hashToken } = require('../utils/crypto');
const { sendForgotPasswordOtpEmail, sendEmailVerificationOtp } = require('../services/emailService');
const {
  ACCESS_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
  getAccessTokenOptions,
  getRefreshTokenOptions,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  decodeToken,
} = require('../utils/tokens');

const PASSWORD_RESET_OTP_TTL_MS = 15 * 60 * 1000;
const EMAIL_VERIFICATION_OTP_TTL_MS = 30 * 60 * 1000;

function getPublicUser(user) {
  return {
    id: user._id.toString(),
    username: user.username,
    email: user.email,
    role: user.role,
    isApproved: user.isApproved,
    createdAt: user.createdAt,
  };
}

function generateNumericOtp(length = 6) {
  let otp = '';
  for (let i = 0; i < length; i += 1) {
    otp += Math.floor(Math.random() * 10).toString();
  }
  return otp;
}

async function issueAndSendPasswordResetOtp(user) {
  const otpCode = generateNumericOtp(6);
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_OTP_TTL_MS);

  user.passwordResetTokenHash = hashToken(otpCode);
  user.passwordResetExpiresAt = expiresAt;
  await user.save();

  await sendForgotPasswordOtpEmail(user.email, otpCode, expiresAt);
  return expiresAt;
}

async function issueAndSendEmailVerificationOtp(user) {
  const otpCode = generateNumericOtp(6);
  const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_OTP_TTL_MS);

  user.emailVerificationTokenHash = hashToken(otpCode);
  user.emailVerificationExpiresAt = expiresAt;
  await user.save();

  await sendEmailVerificationOtp(user.email, otpCode, expiresAt);
  return expiresAt;
}

async function createAuditLog(performedBy, action, targetUser, details, ip) {
  try {
    await AuditLog.create({
      performedBy,
      action,
      targetUser: targetUser || null,
      details: details || {},
      ip: ip || '',
    });
  } catch (error) {
    console.error('Failed to create audit log:', error?.message || error);
  }
}

function setAuthCookies(res, accessToken, refreshToken) {
  res.cookie(ACCESS_TOKEN_COOKIE, accessToken, getAccessTokenOptions());
  res.cookie(REFRESH_TOKEN_COOKIE, refreshToken, getRefreshTokenOptions());
}

function clearAuthCookies(res) {
  const isProd = process.env.NODE_ENV === 'production';
  res.clearCookie(ACCESS_TOKEN_COOKIE, {
    httpOnly: true,
    sameSite: isProd ? 'none' : 'strict',
    secure: isProd,
  });
  res.clearCookie(REFRESH_TOKEN_COOKIE, {
    httpOnly: true,
    sameSite: isProd ? 'none' : 'strict',
    secure: isProd,
  });
}

async function issueTokenPair(user, reqIp, previousRefreshTokenHash = null, family = crypto.randomUUID()) {
  const accessToken = signAccessToken(user);
  const refreshToken = signRefreshToken(user, family);
  const refreshPayload = verifyRefreshToken(refreshToken);
  const refreshTokenHash = hashToken(refreshToken);

  await RefreshToken.create({
    user: user._id,
    tokenHash: refreshTokenHash,
    family,
    parentTokenHash: previousRefreshTokenHash,
    expiresAt: new Date(refreshPayload.exp * 1000),
    createdByIp: reqIp || '',
  });

  return { accessToken, refreshToken, refreshTokenHash, family };
}

async function register(req, res) {
  const {
    email,
    username,
    password,
    confirmPassword,
  } = req.body;

  if (password !== confirmPassword) {
    return res.status(400).json({ message: 'Passwords do not match' });
  }

  const normalizedUsername = username.toLowerCase().trim();
  const normalizedEmail = email.toLowerCase().trim();

  const existingByUsername = await User.findOne({ username: normalizedUsername }).lean();
  if (existingByUsername) {
    return res.status(409).json({ message: 'Username is already in use' });
  }

  const existingByEmail = await User.findOne({ email: normalizedEmail }).lean();
  if (existingByEmail) {
    return res.status(409).json({ message: 'Email is already in use' });
  }

  const user = await User.create({
    username: normalizedUsername,
    email: normalizedEmail,
    password,
    role: 'user',
    isApproved: false,
    isEmailVerified: false,
  });

  let otpValidUntil;
  try {
    const expiresAt = await issueAndSendEmailVerificationOtp(user);
    otpValidUntil = expiresAt.toISOString();
  } catch (emailError) {
    console.error('Verification OTP send failed during registration:', emailError?.message || emailError);
  }

  return res.status(201).json({
    message: 'Registration successful. Please check your email for a 6-digit verification code.',
    requiresEmailVerification: true,
    otpValidUntil,
    user: getPublicUser(user),
  });
}

async function login(req, res) {
  const { username, password } = req.body;
  const normalizedUsername = username.toLowerCase().trim();
  const user = await User.findOne({ username: normalizedUsername }).select('+password');

  if (!user) {
    return res.status(401).json({ message: 'Invalid credentials' });
  }

  if (user.isLocked) {
    return res.status(423).json({
      message: 'Account is temporarily locked due to failed login attempts',
      lockUntil: user.lockUntil,
    });
  }

  const isValidPassword = await user.comparePassword(password);
  if (!isValidPassword) {
    await user.recordFailedLogin();
    return res.status(401).json({ message: 'Invalid credentials' });
  }

  if (!user.isEmailVerified && user.role !== 'admin') {
    return res.status(403).json({
      message: 'Email not verified. Please verify your email before logging in.',
      requiresEmailVerification: true,
    });
  }

  if (!user.isApproved && user.role !== 'admin') {
    return res.status(403).json({ message: 'Account pending admin approval' });
  }

  await user.resetLoginAttempts();

  const { accessToken, refreshToken } = await issueTokenPair(user, req.ip);
  setAuthCookies(res, accessToken, refreshToken);

  return res.json({
    message: 'Login successful',
    user: getPublicUser(user),
  });
}

async function requestForgotPasswordOtp(req, res) {
  const normalizedEmail = String(req.body?.email || '').toLowerCase().trim();

  if (!normalizedEmail) {
    return res.status(400).json({ message: 'Email is required' });
  }

  const user = await User.findOne({ email: normalizedEmail });
  if (!user) {
    return res.json({
      message: 'If an approved account exists for that email, an OTP has been sent.',
    });
  }

  if (!user.isApproved && user.role !== 'admin') {
    return res.status(403).json({ message: 'Account pending admin approval' });
  }

  let expiresAt;
  try {
    expiresAt = await issueAndSendPasswordResetOtp(user);
  } catch (error) {
    console.error('Forgot-password OTP send failed:', error?.message || error);
    return res.status(500).json({ message: 'Failed to send forgot-password OTP' });
  }

  return res.status(202).json({
    message: 'OTP sent. Check your email to continue password reset.',
    otpValidUntil: expiresAt.toISOString(),
  });
}

async function resetPasswordWithOtp(req, res) {
  const normalizedEmail = String(req.body?.email || '').toLowerCase().trim();
  const otp = String(req.body?.otp || '').trim();
  const newPassword = String(req.body?.newPassword || '');

  const user = await User.findOne({ email: normalizedEmail });
  if (!user) {
    return res.status(400).json({ message: 'Invalid or expired OTP' });
  }

  if (!user.isApproved && user.role !== 'admin') {
    return res.status(403).json({ message: 'Account pending admin approval' });
  }

  if (
    !user.passwordResetTokenHash
    || !user.passwordResetExpiresAt
    || user.passwordResetExpiresAt <= new Date()
  ) {
    return res.status(400).json({ message: 'OTP is missing or expired' });
  }

  const otpHash = hashToken(otp);
  if (otpHash !== user.passwordResetTokenHash) {
    return res.status(401).json({ message: 'Invalid OTP' });
  }

  user.password = newPassword;
  user.passwordResetTokenHash = null;
  user.passwordResetExpiresAt = null;
  user.loginAttempts = 0;
  user.lockUntil = null;
  await user.save();

  return res.json({ message: 'Password reset successful. You can now login with your new password.' });
}

async function verifyEmailOtp(req, res) {
  const normalizedEmail = String(req.body?.email || '').toLowerCase().trim();
  const otp = String(req.body?.otp || '').trim();

  const user = await User.findOne({ email: normalizedEmail });
  if (!user) {
    return res.status(400).json({ message: 'Invalid or expired verification code' });
  }

  if (user.isEmailVerified) {
    return res.status(400).json({ message: 'Email is already verified' });
  }

  if (
    !user.emailVerificationTokenHash
    || !user.emailVerificationExpiresAt
    || user.emailVerificationExpiresAt <= new Date()
  ) {
    return res.status(400).json({ message: 'Verification code is missing or expired. Please request a new one.' });
  }

  const otpHash = hashToken(otp);
  if (otpHash !== user.emailVerificationTokenHash) {
    return res.status(401).json({ message: 'Invalid verification code' });
  }

  user.isEmailVerified = true;
  user.emailVerificationTokenHash = null;
  user.emailVerificationExpiresAt = null;
  await user.save();

  return res.json({ message: 'Email verified successfully. Your account is now pending admin approval.' });
}

async function resendVerificationOtp(req, res) {
  const normalizedEmail = String(req.body?.email || '').toLowerCase().trim();

  const user = await User.findOne({ email: normalizedEmail });
  if (!user) {
    return res.json({ message: 'If an unverified account exists with that email, a new code has been sent.' });
  }

  if (user.isEmailVerified) {
    return res.status(400).json({ message: 'Email is already verified' });
  }

  let expiresAt;
  try {
    expiresAt = await issueAndSendEmailVerificationOtp(user);
  } catch (error) {
    console.error('Verification OTP resend failed:', error?.message || error);
    return res.status(500).json({ message: 'Failed to send verification email' });
  }

  return res.status(202).json({
    message: 'A new verification code has been sent to your email.',
    otpValidUntil: expiresAt.toISOString(),
  });
}

async function getAuditLogs(req, res) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const skip = (page - 1) * limit;

  const [logs, total] = await Promise.all([
    AuditLog.find({})
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('performedBy', 'username email')
      .populate('targetUser', 'username email')
      .lean(),
    AuditLog.countDocuments({}),
  ]);

  return res.json({ logs, total, page, limit });
}

async function refresh(req, res) {
  const refreshToken = req.cookies[REFRESH_TOKEN_COOKIE];
  if (!refreshToken) {
    return res.status(401).json({ message: 'Refresh token missing' });
  }

  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch (error) {
    return res.status(401).json({ message: 'Invalid refresh token' });
  }

  const refreshTokenHash = hashToken(refreshToken);
  const existing = await RefreshToken.findOne({ tokenHash: refreshTokenHash, user: payload.sub });

  if (!existing || existing.revokedAt || existing.expiresAt <= new Date()) {
    if (payload.family) {
      await RefreshToken.updateMany(
        { user: payload.sub, family: payload.family, revokedAt: null },
        { $set: { revokedAt: new Date() } }
      );
    }
    clearAuthCookies(res);
    return res.status(401).json({ message: 'Refresh token reuse detected or token expired' });
  }

  const user = await User.findById(payload.sub);
  if (!user) {
    clearAuthCookies(res);
    return res.status(401).json({ message: 'User not found' });
  }

  existing.revokedAt = new Date();
  const issued = await issueTokenPair(user, req.ip, refreshTokenHash, existing.family);
  existing.replacedByTokenHash = issued.refreshTokenHash;
  await existing.save();

  setAuthCookies(res, issued.accessToken, issued.refreshToken);

  return res.json({
    message: 'Token refreshed',
    user: getPublicUser(user),
  });
}

async function logout(req, res) {
  const accessToken = req.cookies[ACCESS_TOKEN_COOKIE];
  const refreshToken = req.cookies[REFRESH_TOKEN_COOKIE];

  if (accessToken) {
    const payload = decodeToken(accessToken);
    if (payload?.exp) {
      await TokenBlacklist.updateOne(
        { tokenHash: hashToken(accessToken) },
        {
          $setOnInsert: {
            tokenHash: hashToken(accessToken),
            user: payload.sub,
            type: 'access',
            expiresAt: new Date(payload.exp * 1000),
          },
        },
        { upsert: true }
      );
    }
  }

  if (refreshToken) {
    const refreshTokenHash = hashToken(refreshToken);
    const payload = decodeToken(refreshToken);

    await RefreshToken.updateMany(
      {
        user: payload?.sub,
        family: payload?.family,
        revokedAt: null,
      },
      { $set: { revokedAt: new Date() } }
    );

    if (payload?.exp) {
      await TokenBlacklist.updateOne(
        { tokenHash: refreshTokenHash },
        {
          $setOnInsert: {
            tokenHash: refreshTokenHash,
            user: payload.sub,
            type: 'refresh',
            expiresAt: new Date(payload.exp * 1000),
          },
        },
        { upsert: true }
      );
    }
  }

  clearAuthCookies(res);
  return res.json({ message: 'Logout successful' });
}

async function me(req, res) {
  if (!req.user) {
    return res.json({ user: null });
  }

  const user = await User.findById(req.user.id).select('-password').lean();
  if (!user) {
    return res.status(404).json({ message: 'User not found' });
  }

  return res.json({ user: getPublicUser(user) });
}

async function pendingApprovals(req, res) {
  const users = await User.find({ isApproved: false, role: 'user' })
    .select('_id username role isApproved createdAt')
    .sort({ createdAt: -1 })
    .lean();

  const normalizedUsers = users.map((user) => ({
    id: user._id.toString(),
    username: user.username,
    role: user.role,
    isApproved: user.isApproved,
    createdAt: user.createdAt,
  }));

  return res.json({ users: normalizedUsers });
}

async function approveUser(req, res) {
  const { id } = req.params;
  const user = await User.findById(id);

  if (!user) {
    return res.status(404).json({ message: 'User not found' });
  }

  user.isApproved = true;
  await user.save();

  await createAuditLog(req.user.id, 'user.approved', user._id, { username: user.username }, req.ip);

  return res.json({
    message: 'User approved successfully',
    user: getPublicUser(user),
  });
}

async function listAccounts(req, res) {
  const users = await User.find({})
    .select('_id username email role isApproved createdAt')
    .sort({ createdAt: -1 })
    .lean();

  const normalizedUsers = users.map((user) => ({
    id: user._id.toString(),
    username: user.username,
    email: user.email,
    role: user.role,
    isApproved: user.isApproved,
    createdAt: user.createdAt,
  }));

  return res.json({ users: normalizedUsers });
}

async function updateAccount(req, res) {
  const { id } = req.params;
  const { role, isApproved } = req.body || {};

  if (typeof role === 'undefined' && typeof isApproved === 'undefined') {
    return res.status(400).json({ message: 'No account changes provided' });
  }

  if (typeof role !== 'undefined' && !['user', 'admin'].includes(role)) {
    return res.status(400).json({ message: 'Invalid role' });
  }

  if (typeof isApproved !== 'undefined' && typeof isApproved !== 'boolean') {
    return res.status(400).json({ message: 'Invalid approval status' });
  }

  const user = await User.findById(id);
  if (!user) {
    return res.status(404).json({ message: 'User not found' });
  }

  if (req.user?.id === user._id.toString()) {
    return res.status(400).json({ message: 'You cannot modify your own account here' });
  }

  if (typeof role !== 'undefined') {
    user.role = role;
  }

  if (typeof isApproved !== 'undefined') {
    user.isApproved = isApproved;

  }

  await user.save();

  await createAuditLog(req.user.id, 'account.updated', user._id, {
    changes: {
      ...(typeof role !== 'undefined' && { role }),
      ...(typeof isApproved !== 'undefined' && { isApproved }),
    },
    username: user.username,
  }, req.ip);

  return res.json({
    message: 'Account updated successfully',
    user: getPublicUser(user),
  });
}

module.exports = {
  register,
  login,
  refresh,
  logout,
  me,
  pendingApprovals,
  approveUser,
  listAccounts,
  updateAccount,
  requestForgotPasswordOtp,
  resetPasswordWithOtp,
  verifyEmailOtp,
  resendVerificationOtp,
  getAuditLogs,
};
