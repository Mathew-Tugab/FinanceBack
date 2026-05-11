require('express-async-errors'); // Must be first — patches Express to forward async errors to error handler
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const mongoSanitize = require('express-mongo-sanitize');
require('dotenv').config();

// ── Startup environment variable validation ───────────────────────────────────
// Log clearly which required variables are missing so Render logs show the
// exact problem instead of an opaque crash deeper in the code.
const REQUIRED_ENV = [
  'MONGODB_URI',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
];
const missingEnv = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missingEnv.length > 0) {
  console.error('FATAL: Missing required environment variables:', missingEnv.join(', '));
  console.error('Set these in your Render environment dashboard and redeploy.');
  process.exit(1);
}
// ─────────────────────────────────────────────────────────────────────────────

const User = require('./models/User');
const { generalApiLimiter } = require('./middleware/rateLimiters');

const app = express();

// Render (and most cloud platforms) sit behind a reverse proxy that sets
// X-Forwarded-For. Without this, express-rate-limit cannot identify clients
// correctly and throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR.
app.set('trust proxy', 1);

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

console.log('Allowed CORS origins:', allowedOrigins);

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (server-to-server, curl, Postman)
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      // Reject but do NOT throw — throwing prevents CORS headers from being
      // attached, making every error look like a CORS error to the browser.
      return callback(null, false);
    },
    credentials: true,
    // Explicitly list every header the frontend sends so preflight requests
    // are approved. Wildcards are ignored when credentials:true.
    allowedHeaders: ['Content-Type', 'x-csrf-token'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
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
  // Log the error but keep the server alive so Render doesn't return 502.
  // CORS preflight and health-check requests will still succeed.
  console.error('MongoDB connection error — server will continue running but DB operations will fail:', err);
});

// Mongoose connection lifecycle logging — helps diagnose cold-start DB issues
// on Render free tier where the container sleeps and the Atlas connection drops.
mongoose.connection.on('disconnected', () => console.warn('MongoDB disconnected — waiting to reconnect...'));
mongoose.connection.on('reconnected', () => console.log('MongoDB reconnected'));
mongoose.connection.on('error', (err) => console.error('MongoDB runtime error:', err.message || err));

// Keep the process alive if a stray unhandled rejection slips through
// (e.g., a DB query fires before reconnection). Without this, Node 15+
// exits with code 1 → Render returns 502.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection (server kept alive):', reason);
});

// Apply general rate limiter to all API routes
app.use('/api/', generalApiLimiter);

// DB readiness guard — return 503 (not 500) when MongoDB is not yet connected.
// This gives the frontend a clear "try again" signal instead of a crash.
// Health check and root are intentionally excluded.
app.use((req, res, next) => {
  const { readyState } = mongoose.connection;
  // 1 = connected, 2 = connecting (allow through — query will queue internally)
  if (readyState === 0 || readyState === 3) {
    return res.status(503).json({
      message: 'Database is not connected. Please try again in a moment.',
    });
  }
  return next();
});

// Routes
const paymentRoutes = require('./routes/payments');
const formSyncRoutes = require('./routes/formSync');
const authRoutes = require('./routes/auth');
const protectedRoutes = require('./routes/protected');

app.use('/api/auth', authRoutes);
app.use('/api/protected', protectedRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/form-sync', formSyncRoutes);

// Health check endpoint — reports DB state so you can diagnose cold starts
app.get('/api/health', (req, res) => {
  const states = { 0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting' };
  const dbState = states[mongoose.connection.readyState] || 'unknown';
  const ok = mongoose.connection.readyState === 1;
  res.status(ok ? 200 : 503).json({
    status: ok ? 'ok' : 'degraded',
    db: dbState,
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({ message: 'ATSOCA Payment Tracking API' });
});

// Global error handler — must be last, after all routes.
// Always returns JSON (never HTML) so the frontend can parse errors,
// and always sets CORS headers so the browser can read the response.
app.use((error, req, res, next) => { // eslint-disable-line no-unused-vars
  // Re-apply CORS for the error response so the browser can read the body
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }

  if (error.code === 'EBADCSRFTOKEN') {
    return res.status(403).json({ message: 'Invalid CSRF token' });
  }

  // If this fires it is a genuine server bug — log it and return a safe message.
  console.error('Unhandled server error:', error);
  const status = error.status || error.statusCode || 500;
  return res.status(status).json({
    message: process.env.NODE_ENV === 'production'
      ? 'An unexpected error occurred'
      : (error.message || 'Internal server error'),
  });
});

// Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`API available at http://localhost:${PORT}/api`);

  // ── Keep-alive ping (Render free tier) ──────────────────────────────────────
  // Render spins down free services after 15 min of inactivity, causing a
  // 30-60 s cold start on the next request. Pinging our own health endpoint
  // every 14 min keeps the container warm without any external service.
  // RENDER_EXTERNAL_URL is automatically set by Render in production.
  const renderUrl = process.env.RENDER_EXTERNAL_URL;
  if (renderUrl) {
    const https = require('https');
    const PING_INTERVAL_MS = 14 * 60 * 1000; // 14 minutes

    setInterval(() => {
      const target = `${renderUrl}/api/health`;
      https.get(target, (res) => {
        console.log(`Keep-alive ping → ${target} [${res.statusCode}]`);
      }).on('error', (err) => {
        console.warn('Keep-alive ping failed:', err.message);
      });
    }, PING_INTERVAL_MS);

    console.log(`Keep-alive ping enabled → ${renderUrl}/api/health every 14 min`);
  }
  // ────────────────────────────────────────────────────────────────────────────
});
