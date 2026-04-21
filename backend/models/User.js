const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const MAX_LOGIN_ATTEMPTS = Number(process.env.MAX_LOGIN_ATTEMPTS || 5);
const LOCK_TIME_MS = Number(process.env.ACCOUNT_LOCK_TIME_MS || 2 * 60 * 60 * 1000);

const userSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      minlength: 3,
      maxlength: 32,
      index: true,
      unique: true,
    },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true,
      unique: true,
    },
    password: {
      type: String,
      required: true,
      minlength: 8,
      select: false,
    },
    role: {
      type: String,
      enum: ['user', 'admin'],
      default: 'user',
      index: true,
    },
    isApproved: {
      type: Boolean,
      default: false,
      index: true,
    },
    isEmailVerified: {
      type: Boolean,
      default: false,
      index: true,
    },
    emailVerificationTokenHash: {
      type: String,
      default: null,
      index: true,
    },
    emailVerificationExpiresAt: {
      type: Date,
      default: null,
    },
    passwordResetTokenHash: {
      type: String,
      default: null,
      index: true,
    },
    passwordResetExpiresAt: {
      type: Date,
      default: null,
    },
    loginAttempts: {
      type: Number,
      default: 0,
    },
    lockUntil: {
      type: Date,
      default: null,
    },
    otpRequiredAfterApproval: {
      type: Boolean,
      default: false,
      index: true,
    },
    hasCompletedPostApprovalOtp: {
      type: Boolean,
      default: false,
      index: true,
    },
    loginOtpHash: {
      type: String,
      default: null,
      index: true,
    },
    loginOtpExpiresAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

userSchema.virtual('isLocked').get(function isLocked() {
  return !!(this.lockUntil && this.lockUntil > Date.now());
});

userSchema.pre('save', async function hashPassword(next) {
  if (!this.isModified('password')) {
    return next();
  }

  this.password = await bcrypt.hash(this.password, Number(process.env.BCRYPT_ROUNDS || 12));
  next();
});

userSchema.methods.comparePassword = function comparePassword(rawPassword) {
  return bcrypt.compare(rawPassword, this.password);
};

userSchema.methods.recordFailedLogin = async function recordFailedLogin() {
  if (this.lockUntil && this.lockUntil < Date.now()) {
    this.loginAttempts = 1;
    this.lockUntil = null;
    await this.save();
    return;
  }

  this.loginAttempts += 1;
  if (this.loginAttempts >= MAX_LOGIN_ATTEMPTS && !this.isLocked) {
    this.lockUntil = new Date(Date.now() + LOCK_TIME_MS);
  }
  await this.save();
};

userSchema.methods.resetLoginAttempts = async function resetLoginAttempts() {
  this.loginAttempts = 0;
  this.lockUntil = null;
  await this.save();
};

module.exports = mongoose.model('User', userSchema);
