const mongoose = require('mongoose');

const storedImageSchema = new mongoose.Schema(
  {
    originalName: {
      type: String,
      default: 'upload',
    },
    contentType: {
      type: String,
      required: true,
    },
    size: {
      type: Number,
      required: true,
    },
    data: {
      type: Buffer,
      required: true,
    },
    source: {
      type: String,
      enum: ['manual-upload', 'base64', 'google-form', 'legacy-upload'],
      default: 'manual-upload',
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('StoredImage', storedImageSchema);
