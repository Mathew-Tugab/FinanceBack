const { body, query, validationResult } = require('express-validator');

const usernameRule = body('username')
  .isString()
  .trim()
  .isLength({ min: 3, max: 32 })
  .withMessage('Username must be 3-32 characters')
  .matches(/^[a-zA-Z0-9._-]+$/)
  .withMessage('Username may only contain letters, numbers, dot, underscore, and hyphen');

const emailRule = body('email').isEmail().normalizeEmail().withMessage('Valid email is required');
const passwordRule = body('password')
  .isLength({ min: 8, max: 128 })
  .withMessage('Password must be 8-128 characters')
  .matches(/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
  .withMessage('Password must include upper, lower and number');

const registerValidator = [
  emailRule,
  usernameRule,
  passwordRule,
  body('confirmPassword')
    .isString()
    .withMessage('Password confirmation is required')
    .custom((confirmPassword, { req }) => confirmPassword === req.body.password)
    .withMessage('Passwords do not match'),
];

const loginValidator = [
  usernameRule,
  body('password').isString().notEmpty().withMessage('Password is required'),
];

const verifyLoginOtpValidator = [
  usernameRule,
  body('password').isString().notEmpty().withMessage('Password is required'),
  body('otp')
    .isString()
    .trim()
    .matches(/^\d{6}$/)
    .withMessage('OTP must be a 6-digit code'),
];

const resendLoginOtpValidator = [
  usernameRule,
  body('password').isString().notEmpty().withMessage('Password is required'),
];

const resendVerificationValidator = [emailRule];

const resendVerificationOtpValidator = [emailRule];

const verifyEmailOtpValidator = [
  emailRule,
  body('otp')
    .isString()
    .trim()
    .matches(/^\d{6}$/)
    .withMessage('OTP must be a 6-digit code'),
];

const verifyEmailValidator = [
  query('token').isString().isLength({ min: 32 }).withMessage('Verification token is required'),
];

const forgotPasswordValidator = [emailRule];

const requestForgotPasswordOtpValidator = [emailRule];

const resetPasswordWithOtpValidator = [
  emailRule,
  body('otp')
    .isString()
    .trim()
    .matches(/^\d{6}$/)
    .withMessage('OTP must be a 6-digit code'),
  body('newPassword')
    .isLength({ min: 8, max: 128 })
    .withMessage('Password must be 8-128 characters')
    .matches(/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
    .withMessage('Password must include upper, lower and number'),
];

const resetPasswordValidator = [
  body('token').isString().isLength({ min: 32 }).withMessage('Reset token is required'),
  passwordRule,
];

function validateRequest(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      message: 'Validation failed',
      errors: errors.array().map((e) => ({ field: e.path, message: e.msg })),
    });
  }

  return next();
}

module.exports = {
  registerValidator,
  loginValidator,
  verifyLoginOtpValidator,
  resendLoginOtpValidator,
  resendVerificationValidator,
  resendVerificationOtpValidator,
  verifyEmailOtpValidator,
  verifyEmailValidator,
  forgotPasswordValidator,
  requestForgotPasswordOtpValidator,
  resetPasswordWithOtpValidator,
  resetPasswordValidator,
  validateRequest,
};
