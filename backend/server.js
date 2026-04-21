const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const mongoSanitize = require('express-mongo-sanitize');
require('dotenv').config();
const User = require('./models/User');
const { generalApiLimiter } = require('./middleware/rateLimiters');

const app = express();

async function removeLegacyReferenceNumberUniqueIndex() {
  try {
    const collection = mongoose.connection.collection('paymentrecords');
    const indexes = await collection.indexes();

    const referenceUniqueIndexes = indexes.filter((idx) => {
      const key = idx?.key || {};
      return idx.unique === true && Object.keys(key).length === 1 && key.referenceNumber === 1;
    });

    if (referenceUniqueIndexes.length === 0) {
      return;
    }

    for (const index of referenceUniqueIndexes) {
      await collection.dropIndex(index.name);
      console.log(`Dropped legacy unique index: ${index.name}`);
    }
  } catch (error) {
    if (error?.codeName === 'NamespaceNotFound') {
      return;
    }
    console.error('Failed to remove legacy referenceNumber unique index:', error.message || error);
  }
}

async function ensureDefaultAdminUser() {
  const adminUsername = (process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD || '@soca_spark';

  if (!adminUsername || !adminPassword) {
    console.warn('Default admin bootstrap skipped: missing ADMIN_USERNAME or ADMIN_PASSWORD.');
    return;
  }

  const adminEmail = `${adminUsername}@users.local`;
  const existingAdmin = await User.findOne({ username: adminUsername }).select('+password');

  if (!existingAdmin) {
    await User.create({
      username: adminUsername,
      email: adminEmail,
      password: adminPassword,
      role: 'admin',
      isApproved: true,
      isEmailVerified: true,
      otpRequiredAfterApproval: false,
      hasCompletedPostApprovalOtp: true,
    });
    console.log(`Default admin created: ${adminUsername}`);
    return;
  }

  existingAdmin.role = 'admin';
  existingAdmin.isApproved = true;
  existingAdmin.email = adminEmail;
  existingAdmin.isEmailVerified = true;
  existingAdmin.otpRequiredAfterApproval = false;
  existingAdmin.hasCompletedPostApprovalOtp = true;
  existingAdmin.loginOtpHash = null;
  existingAdmin.loginOtpExpiresAt = null;

  const isPasswordValid = await existingAdmin.comparePassword(adminPassword);
  if (!isPasswordValid) {
    existingAdmin.password = adminPassword;
  }

  await existingAdmin.save();
  console.log(`Default admin ensured: ${adminUsername}`);
}

// Middleware
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error('CORS origin is not allowed'));
    },
    credentials: true,
  })
);
app.use(helmet());
app.use(cookieParser());
app.use(mongoSanitize());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// MongoDB Connection
const mongodbUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/atsoca';

mongoose.connect(mongodbUri, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => {
  console.log('Connected to MongoDB');
  console.log('Database: atsoca');
  removeLegacyReferenceNumberUniqueIndex();
  ensureDefaultAdminUser();
})
.catch((err) => {
  console.error('MongoDB connection error:', err);
  process.exit(1);
});

// Apply general rate limiter to all API routes
app.use('/api/', generalApiLimiter);

// Routes
const paymentRoutes = require('./routes/payments');
const formSyncRoutes = require('./routes/formSync');
const authRoutes = require('./routes/auth');
const protectedRoutes = require('./routes/protected');

app.use('/api/auth', authRoutes);
app.use('/api/protected', protectedRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/form-sync', formSyncRoutes);

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'Server is running' });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({ message: 'ATSOCA Payment Tracking API' });
});

app.use((error, req, res, next) => {
  if (error.code === 'EBADCSRFTOKEN') {
    return res.status(403).json({ message: 'Invalid CSRF token' });
  }

  if (error.message === 'CORS origin is not allowed') {
    return res.status(403).json({ message: 'CORS denied for this origin' });
  }

  return next(error);
});

// Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`API available at http://localhost:${PORT}/api`);
});
