const mongoose = require('mongoose');
const StoredImage = require('../models/StoredImage');

const IMAGE_MARKER_PREFIX = 'dbimg:';

function toImageMarker(id) {
  return `${IMAGE_MARKER_PREFIX}${id}`;
}

function extractStoredImageId(value) {
  if (!value || typeof value !== 'string') return null;
  if (!value.startsWith(IMAGE_MARKER_PREFIX)) return null;

  const id = value.slice(IMAGE_MARKER_PREFIX.length).trim();
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  return id;
}

async function saveImageBuffer({ buffer, contentType, originalName, source }) {
  if (!buffer || !contentType) return '';

  const storedImage = await StoredImage.create({
    originalName: originalName || 'upload',
    contentType,
    size: buffer.length,
    data: buffer,
    source: source || 'manual-upload',
  });

  return toImageMarker(storedImage._id);
}

async function saveDataUrlImage(dataUrl, options = {}) {
  if (!dataUrl || typeof dataUrl !== 'string') return '';

  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return '';

  const contentType = match[1];
  const base64Payload = match[2];
  const buffer = Buffer.from(base64Payload, 'base64');

  if (!buffer.length) return '';

  return saveImageBuffer({
    buffer,
    contentType,
    originalName: options.originalName || 'upload',
    source: options.source || 'base64',
  });
}

async function deleteStoredImageByMarker(marker) {
  const imageId = extractStoredImageId(marker);
  if (!imageId) return;
  await StoredImage.findByIdAndDelete(imageId);
}

module.exports = {
  IMAGE_MARKER_PREFIX,
  extractStoredImageId,
  saveImageBuffer,
  saveDataUrlImage,
  deleteStoredImageByMarker,
};
