const express = require('express');
const {
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
} = require('../controllers/authController');
const { authenticate, optionalAuthenticate } = require('../middleware/auth');
const { authorizeRoles } = require('../middleware/roles');
const { authLoginLimiter, registerLimiter, verifyEmailLimiter } = require('../middleware/rateLimiters');
const {
  registerValidator,
  loginValidator,
  verifyEmailOtpValidator,
  resendVerificationOtpValidator,
  requestForgotPasswordOtpValidator,
  resetPasswordWithOtpValidator,
  validateRequest,
} = require('../middleware/validators');
const { csrfProtection } = require('../middleware/csrf');

const router = express.Router();

router.get('/csrf-token', csrfProtection, (req, res) => {
  res.json({ csrfToken: req.csrfToken() });
});

router.post('/register', csrfProtection, registerLimiter, registerValidator, validateRequest, register);
router.post('/verify-email-otp', csrfProtection, verifyEmailLimiter, verifyEmailOtpValidator, validateRequest, verifyEmailOtp);
router.post('/resend-verification-otp', csrfProtection, verifyEmailLimiter, resendVerificationOtpValidator, validateRequest, resendVerificationOtp);
router.post('/login', csrfProtection, authLoginLimiter, loginValidator, validateRequest, login);
router.post('/forgot-password/request-otp', csrfProtection, authLoginLimiter, requestForgotPasswordOtpValidator, validateRequest, requestForgotPasswordOtp);
router.post('/forgot-password/reset-with-otp', csrfProtection, authLoginLimiter, resetPasswordWithOtpValidator, validateRequest, resetPasswordWithOtp);
router.post('/refresh', csrfProtection, refresh);
router.post('/logout', csrfProtection, logout);
router.get('/me', optionalAuthenticate, me);
router.get('/pending-approvals', authenticate, authorizeRoles('admin'), pendingApprovals);
router.patch('/approve/:id', csrfProtection, authenticate, authorizeRoles('admin'), approveUser);
router.get('/accounts', authenticate, authorizeRoles('admin'), listAccounts);
router.patch('/accounts/:id', csrfProtection, authenticate, authorizeRoles('admin'), updateAccount);
router.get('/audit-logs', authenticate, authorizeRoles('admin'), getAuditLogs);

module.exports = router;
