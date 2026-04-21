const express = require('express');
const multer = require('multer');
const { authenticate } = require('../middleware/auth');
const { authorizeRoles } = require('../middleware/roles');
const { validateFileUpload } = require('../middleware/uploadValidation');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

router.get('/profile', authenticate, (req, res) => {
  res.json({
    message: 'Protected profile route reached',
    user: req.user,
  });
});

router.get('/admin-only', authenticate, authorizeRoles('admin'), (req, res) => {
  res.json({
    message: 'Admin-only resource',
  });
});

router.post('/upload', authenticate, upload.single('file'), validateFileUpload, (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'No file uploaded' });
  }

  return res.json({
    message: 'File metadata validated successfully',
    filename: req.file.originalname,
    mimetype: req.file.mimetype,
    size: req.file.size,
  });
});

module.exports = router;
