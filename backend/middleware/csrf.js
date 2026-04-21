const csurf = require('csurf');

const isProd = process.env.NODE_ENV === 'production';

const csrfProtection = csurf({
  // CSRF secret is stored in a cookie so server remains stateless.
  // sameSite must be 'none' in production because the frontend (Vercel) and
  // backend (Render) are different origins — 'strict' blocks the cookie.
  cookie: {
    key: '_csrfSecret',
    httpOnly: true,
    sameSite: isProd ? 'none' : 'strict',
    secure: isProd,
  },
  value: (req) => req.headers['x-csrf-token'],
});

module.exports = {
  csrfProtection,
};
