const allowedMimeTypes = ['image/jpeg', 'image/png', 'application/pdf'];
const maxFileSizeBytes = Number(process.env.MAX_UPLOAD_BYTES || 5 * 1024 * 1024);

function validateFileUpload(req, res, next) {
  if (!req.file) {
    return next();
  }

  if (!allowedMimeTypes.includes(req.file.mimetype)) {
    return res.status(400).json({ message: 'Unsupported file type' });
  }

  if (req.file.size > maxFileSizeBytes) {
    return res.status(400).json({ message: 'File exceeds maximum allowed size' });
  }

  return next();
}

module.exports = {
  validateFileUpload,
};
