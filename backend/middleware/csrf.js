// Origin-header CSRF protection.
//
// The csurf cookie double-submit pattern breaks in cross-origin SPA setups
// (frontend on Vercel, backend on Render) because the browser may refuse to
// attach the _csrfSecret cookie for third-party requests even with
// SameSite=None before the first explicit credential exchange.
//
// Validating the Origin header is an equivalent and simpler defence:
//   - Browsers always set the Origin header on cross-origin requests.
//   - Attackers cannot forge the Origin header from a browser context.
//   - Our CORS policy already restricts credentialed origins; this adds a
//     second, independent check for state-changing requests.
//
// The /api/auth/csrf-token endpoint continues to work and returns a token
// so that existing frontend code that reads it does not break.  The token
// value itself is no longer verified server-side.

const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

function csrfProtection(req, res, next) {
  // Attach req.csrfToken() so routes that call it (e.g. /csrf-token) still work.
  req.csrfToken = () => 'csrf-origin-validated';

  // Safe / read-only methods do not need CSRF protection.
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }

  const origin = req.headers.origin;

  // No Origin header → same-origin browser request, curl, Postman, etc. — allow.
  if (!origin) {
    return next();
  }

  if (!allowedOrigins.includes(origin)) {
    return res.status(403).json({ message: 'CSRF check failed: origin not allowed' });
  }

  return next();
}

module.exports = {
  csrfProtection,
};
