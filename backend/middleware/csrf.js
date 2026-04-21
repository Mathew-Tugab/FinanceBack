const csurf = require('csurf');

const csrfProtection = csurf({
  // CSRF secret is stored in a cookie so server remains stateless.
  cookie: {
    key: '_csrfSecret',
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
  },
  value: (req) => req.headers['x-csrf-token'],
});

module.exports = {
  csrfProtection,
};
