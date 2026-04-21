const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const PaymentRecord = require('../models/PaymentRecord');
const StoredImage = require('../models/StoredImage');
const { validateFileUpload } = require('../middleware/uploadValidation');
const {
  saveImageBuffer,
  saveDataUrlImage,
  deleteStoredImageByMarker,
} = require('../utils/imageStore');
const { sendPaymentVerifiedEmail } = require('../services/emailService');

const upload = multer({ storage: multer.memoryStorage() });

const LEGACY_UPLOADS_DIR = path.join(__dirname, '..', 'uploads');

const getMimeTypeFromFilename = (filename = '') => {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.pdf') return 'application/pdf';
  return 'application/octet-stream';
};

const extractLegacyUploadFilename = (value = '') => {
  if (!value || typeof value !== 'string') return '';
  const normalized = value.replace(/\\\\/g, '/');

  if (normalized.startsWith('/uploads/')) {
    return normalized.slice('/uploads/'.length);
  }

  if (normalized.startsWith('uploads/')) {
    return normalized.slice('uploads/'.length);
  }

  const uploadsIndex = normalized.indexOf('/uploads/');
  if (uploadsIndex >= 0) {
    return normalized.slice(uploadsIndex + '/uploads/'.length);
  }

  return '';
};

const migrateLegacyUploadImageIfNeeded = async (payment) => {
  if (!payment?.proofOfPaymentImage) return;

  const legacyFilename = extractLegacyUploadFilename(payment.proofOfPaymentImage);
  if (!legacyFilename) return;

  const localPath = path.join(LEGACY_UPLOADS_DIR, legacyFilename);
  if (!fs.existsSync(localPath)) return;

  const fileBuffer = await fs.promises.readFile(localPath);
  if (!fileBuffer.length) return;

  const marker = await saveImageBuffer({
    buffer: fileBuffer,
    contentType: getMimeTypeFromFilename(legacyFilename),
    originalName: payment.proofOfPayment || legacyFilename,
    source: 'legacy-upload',
  });

  payment.proofOfPaymentImage = marker;
  await payment.save();
};

const normalizeImageValue = async (imageValue, originalName) => {
  if (!imageValue || typeof imageValue !== 'string') return imageValue || '';

  const trimmed = imageValue.trim();
  if (!trimmed) return '';

  if (trimmed.startsWith('data:')) {
    return saveDataUrlImage(trimmed, {
      originalName: originalName || 'upload',
      source: 'base64',
    });
  }

  return trimmed;
};

const parseSlotValues = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
};

const normalizeReferenceSlots = (value) => {
  const slots = parseSlotValues(value)
    .slice(0, 4)
    .map((slot) => (typeof slot === 'string' ? slot.trim() : ''));

  while (slots.length < 4) slots.push('');
  return slots;
};

const normalizeImageSlots = async (value, proofOfPaymentName) => {
  const slots = parseSlotValues(value).slice(0, 4);
  const normalized = [];

  for (let index = 0; index < 4; index += 1) {
    const rawSlot = slots[index];
    const rawValue = typeof rawSlot === 'string' ? rawSlot : '';
    normalized.push(await normalizeImageValue(rawValue, proofOfPaymentName));
  }

  return normalized;
};

const getPrimarySlotValue = (slots, preferredSlot = 1) => {
  const slotIndex = Number.isFinite(Number(preferredSlot)) ? Math.max(1, Math.min(4, Number(preferredSlot))) - 1 : 0;
  if (slots[slotIndex]) return slots[slotIndex];
  return slots.find((slot) => !!slot) || '';
};

const normalizeHighlightImageSlot = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.min(4, parsed));
};

/**
 * When referenceLabel is 'Auto', check if any of the provided reference numbers
 * already exist in another record (checking both the primary referenceNumber
 * and the referenceNumbers array). If so, resolve to 'Repeated Reference Number'.
 * Also updates existing 'Auto'-labelled records that share the same reference.
 */
const resolveReferenceLabel = async (referenceNumber, referenceLabel, excludeId, referenceNumbers, previousRefs) => {
  // Manual overrides ('None', 'Group Payment') are kept as-is
  if (referenceLabel && referenceLabel !== 'Auto' && referenceLabel !== 'Repeated Reference Number') {
    return referenceLabel;
  }

  // Collect all non-empty, unique reference numbers to check
  const allRefs = new Set();
  const primary = (referenceNumber || '').trim().toUpperCase();
  if (primary) allRefs.add(primary);
  if (Array.isArray(referenceNumbers)) {
    for (const ref of referenceNumbers) {
      const normalized = (ref || '').trim().toUpperCase();
      if (normalized) allRefs.add(normalized);
    }
  }

  if (allRefs.size === 0) return 'Auto';

  // Build regex patterns for each unique reference number
  const regexPatterns = [...allRefs].map(
    (ref) => new RegExp(`^${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')
  );

  // Check both the primary referenceNumber field and the referenceNumbers array
  const filter = {
    $or: [
      { referenceNumber: { $in: regexPatterns } },
      { referenceNumbers: { $in: regexPatterns } },
    ],
  };
  if (excludeId) filter._id = { $ne: excludeId };

  const duplicateCount = await PaymentRecord.countDocuments(filter);
  if (duplicateCount > 0) {
    // Also update existing records that still have 'Auto' label
    await PaymentRecord.updateMany(
      { ...filter, referenceLabel: 'Auto' },
      { $set: { referenceLabel: 'Repeated Reference Number' } }
    );
    // Re-evaluate old references that this record used to have (they may no longer be duplicates)
    if (Array.isArray(previousRefs) && previousRefs.length > 0) {
      await cleanUpOrphanedLabels(previousRefs, excludeId);
    }
    return 'Repeated Reference Number';
  }

  // No duplicates found — re-evaluate old references that may have been orphaned
  if (Array.isArray(previousRefs) && previousRefs.length > 0) {
    await cleanUpOrphanedLabels(previousRefs, excludeId);
  }

  return 'Auto';
};

/**
 * For each old reference number, check if any other records still share it.
 * If a reference is now unique to a single record, downgrade that record's
 * label from 'Repeated Reference Number' back to 'Auto'.
 */
const cleanUpOrphanedLabels = async (oldRefs, excludeId) => {
  const checked = new Set();
  for (const ref of oldRefs) {
    const normalized = (ref || '').trim().toUpperCase();
    if (!normalized || checked.has(normalized)) continue;
    checked.add(normalized);

    const pattern = new RegExp(`^${normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    const refFilter = {
      $or: [
        { referenceNumber: pattern },
        { referenceNumbers: pattern },
      ],
    };
    if (excludeId) refFilter._id = { $ne: excludeId };

    const remaining = await PaymentRecord.countDocuments(refFilter);
    if (remaining <= 1) {
      // Only one (or zero) record left with this ref — no longer a duplicate
      await PaymentRecord.updateMany(
        { ...refFilter, referenceLabel: 'Repeated Reference Number' },
        { $set: { referenceLabel: 'Auto' } }
      );
    }
  }
};

async function streamStoredImage(req, res) {
  try {
    const { imageId } = req.params;
    if (!imageId) return res.status(400).json({ message: 'Missing image id' });

    const storedImage = await StoredImage.findById(imageId);
    if (!storedImage || !storedImage.data) {
      return res.status(404).json({ message: 'Image not found' });
    }

    res.setHeader('Content-Type', storedImage.contentType || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.send(storedImage.data);
  } catch (error) {
    if (error.name === 'CastError') {
      return res.status(400).json({ message: 'Invalid image id' });
    }
    return res.status(500).json({ message: error.message });
  }
}

router.get('/images/:imageId', streamStoredImage);

// ─── Pagination helpers ───────────────────────────────────────────────────────
const SORT_FIELD_MAP = {
  name: 'completeName',
  email: 'email',
  amount: 'amountPaid',
  status: 'paymentRecord',
  date: 'createdAt',
};

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildCursorCondition(dbField, rawSortValue, cursorId, sortDir) {
  let oid;
  try {
    oid = new mongoose.Types.ObjectId(String(cursorId));
  } catch {
    return null;
  }

  let sortValue = rawSortValue;
  if (dbField === 'createdAt') {
    sortValue = new Date(rawSortValue);
    if (Number.isNaN(sortValue.getTime())) return null;
  }

  const op = sortDir === -1 ? '$lt' : '$gt';
  return {
    $or: [
      { [dbField]: { [op]: sortValue } },
      { [dbField]: sortValue, _id: { [op]: oid } },
    ],
  };
}

// GET slim records — all records, lightweight (no images), used by client for
// global reference-label detection and multi-enrollment grouping.
router.get('/slim', async (req, res) => {
  try {
    const records = await PaymentRecord.find(
      { archived: { $ne: true } },
      'referenceNumber referenceNumbers referenceLabel completeName email enrollProgram amountPaid amountsPaid paymentRecord formSource'
    ).lean();
    res.json(records);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// GET all payment records (cursor-based pagination)
router.get('/', async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const cursorParam = req.query.cursor || null;
    const search = (req.query.search || '').trim();
    const status = req.query.status || 'All';
    const sortKey = SORT_FIELD_MAP[req.query.sort] ? req.query.sort : 'date';
    const dir = req.query.dir === 'asc' ? 'asc' : 'desc';
    const dbSortField = SORT_FIELD_MAP[sortKey];
    const sortDir = dir === 'asc' ? 1 : -1;

    // Build base conditions (no cursor — used for count + aggregate stats)
    const baseConditions = [{ archived: { $ne: true } }];
    if (search) {
      const regex = new RegExp(escapeRegex(search), 'i');
      baseConditions.push({
        $or: [
          { completeName: regex },
          { email: regex },
          { enrollProgram: regex },
          { referenceNumber: regex },
        ],
      });
    }
    if (status === 'Pending' || status === 'Completed') {
      baseConditions.push({ paymentRecord: status });
    }
    const baseFilter = baseConditions.length === 0 ? {}
      : baseConditions.length === 1 ? baseConditions[0]
      : { $and: baseConditions };

    // Build paginated conditions (base + cursor)
    const pageConditions = [...baseConditions];
    if (cursorParam) {
      try {
        const decoded = JSON.parse(Buffer.from(cursorParam, 'base64').toString('utf8'));
        const cursorCond = buildCursorCondition(dbSortField, decoded.sortValue, decoded.id, sortDir);
        if (cursorCond) pageConditions.push(cursorCond);
      } catch {
        // Invalid cursor — ignore and return first page
      }
    }
    const pageFilter = pageConditions.length === 0 ? {}
      : pageConditions.length === 1 ? pageConditions[0]
      : { $and: pageConditions };

    const sortQuery = { [dbSortField]: sortDir, _id: sortDir };

    const [rawPayments, total, aggregateResult] = await Promise.all([
      PaymentRecord.find(pageFilter).sort(sortQuery).limit(limit + 1),
      PaymentRecord.countDocuments(baseFilter),
      PaymentRecord.aggregate([
        { $match: baseFilter },
        {
          $addFields: {
            effectiveAmountPaid: {
              $cond: {
                if: { $and: [{ $isArray: '$amountsPaid' }, { $gt: [{ $size: '$amountsPaid' }, 0] }, { $gt: [{ $reduce: { input: '$amountsPaid', initialValue: 0, in: { $add: ['$$value', { $ifNull: ['$$this', 0] }] } } }, 0] }] },
                then: { $reduce: { input: '$amountsPaid', initialValue: 0, in: { $add: ['$$value', { $ifNull: ['$$this', 0] }] } } },
                else: '$amountPaid'
              }
            }
          }
        },
        {
          $group: {
            _id: null,
            totalPaid: { $sum: '$effectiveAmountPaid' },
            pendingCount: { $sum: { $cond: [{ $eq: ['$paymentRecord', 'Pending'] }, 1, 0] } },
            completedCount: { $sum: { $cond: [{ $eq: ['$paymentRecord', 'Completed'] }, 1, 0] } },
          },
        },
      ]),
    ]);

    const hasMore = rawPayments.length > limit;
    const payments = hasMore ? rawPayments.slice(0, limit) : rawPayments;

    let nextCursor = null;
    if (hasMore && payments.length > 0) {
      const last = payments[payments.length - 1];
      nextCursor = Buffer.from(JSON.stringify({
        id: last._id.toString(),
        sortValue: last[dbSortField],
      })).toString('base64');
    }

    await Promise.all(payments.map((p) => migrateLegacyUploadImageIfNeeded(p)));

    const stats = aggregateResult[0] || { totalPaid: 0, pendingCount: 0, completedCount: 0 };
    res.json({ payments, nextCursor, total, hasMore, stats });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// GET archived payment records
router.get('/archived', async (req, res) => {
  try {
    const payments = await PaymentRecord.find({ archived: true }).sort({ updatedAt: -1 });
    await Promise.all(payments.map((p) => migrateLegacyUploadImageIfNeeded(p)));
    res.json(payments);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// GET a single payment record by ID
router.get('/:id', async (req, res) => {
  try {
    const payment = await PaymentRecord.findById(req.params.id);
    if (!payment) {
      return res.status(404).json({ message: 'Payment record not found' });
    }

    await migrateLegacyUploadImageIfNeeded(payment);

    res.json(payment);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// CREATE a new payment record
router.post('/', upload.single('proofOfPaymentFile'), validateFileUpload, async (req, res) => {
  let proofOfPayment = req.body.proofOfPayment;
  let proofOfPaymentImage = req.body.proofOfPaymentImage;
  const highlightImageSlot = normalizeHighlightImageSlot(req.body.highlightImageSlot);
  const referenceNumbers = normalizeReferenceSlots(req.body.referenceNumbers);
  let proofOfPaymentImages = await normalizeImageSlots(req.body.proofOfPaymentImages, proofOfPayment);

  if (req.file) {
    proofOfPayment = req.file.originalname;
    proofOfPaymentImage = await saveImageBuffer({
      buffer: req.file.buffer,
      contentType: req.file.mimetype,
      originalName: req.file.originalname,
      source: 'manual-upload',
    });
    proofOfPaymentImages[highlightImageSlot - 1] = proofOfPaymentImage;
  } else {
    proofOfPaymentImage = await normalizeImageValue(proofOfPaymentImage, proofOfPayment);
    if (proofOfPaymentImage && !proofOfPaymentImages[highlightImageSlot - 1]) {
      proofOfPaymentImages[highlightImageSlot - 1] = proofOfPaymentImage;
    }
  }

  const referenceNumber =
    (typeof req.body.referenceNumber === 'string' ? req.body.referenceNumber.trim() : '') ||
    getPrimarySlotValue(referenceNumbers, highlightImageSlot);

  if (!proofOfPaymentImage) {
    proofOfPaymentImage = getPrimarySlotValue(proofOfPaymentImages, highlightImageSlot);
  }

  proofOfPaymentImages = normalizeReferenceSlots(proofOfPaymentImages);

  const resolvedLabel = await resolveReferenceLabel(referenceNumber, req.body.referenceLabel, null, referenceNumbers);

  const paymentRecord = new PaymentRecord({
    email: req.body.email,
    completeName: req.body.completeName,
    enrollProgram: req.body.enrollProgram,
    paymentInstallment: req.body.paymentInstallment,
    trainingFee: Object.prototype.hasOwnProperty.call(req.body, 'trainingFee') ? req.body.trainingFee : req.body.amountPaid,
    amountPaid: req.body.amountPaid,
    amountsPaid: Array.isArray(req.body.amountsPaid) ? req.body.amountsPaid.slice(0, 4).map(v => Number(v) || 0) : [],
    paymentRecord: req.body.paymentRecord,
    concerns: req.body.concerns,
    referenceNumber,
    referenceNumbers,
    referenceLabel: resolvedLabel,
    proofOfPayment,
    proofOfPaymentImage,
    proofOfPaymentImages,
    highlightImageSlot,
  });

  try {
    const newPayment = await paymentRecord.save();
    res.status(201).json(newPayment);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// UPDATE a payment record
router.put('/:id', upload.single('proofOfPaymentFile'), validateFileUpload, async (req, res) => {
  try {
    const payment = await PaymentRecord.findById(req.params.id);
    if (!payment) {
      return res.status(404).json({ message: 'Payment record not found' });
    }

    const previousImageMarker = payment.proofOfPaymentImage || '';
  const previousImageMarkers = Array.isArray(payment.proofOfPaymentImages) ? payment.proofOfPaymentImages : [];
    const previousStatus = payment.paymentRecord;
    const previousRefs = [
      payment.referenceNumber || '',
      ...(Array.isArray(payment.referenceNumbers) ? payment.referenceNumbers : []),
    ].filter(Boolean);

    if (Object.prototype.hasOwnProperty.call(req.body, 'email')) payment.email = req.body.email;
    if (Object.prototype.hasOwnProperty.call(req.body, 'completeName')) payment.completeName = req.body.completeName;
    if (Object.prototype.hasOwnProperty.call(req.body, 'enrollProgram')) payment.enrollProgram = req.body.enrollProgram;
    if (Object.prototype.hasOwnProperty.call(req.body, 'paymentInstallment')) payment.paymentInstallment = req.body.paymentInstallment;
    if (Object.prototype.hasOwnProperty.call(req.body, 'trainingFee')) payment.trainingFee = req.body.trainingFee;
    if (Object.prototype.hasOwnProperty.call(req.body, 'amountPaid')) payment.amountPaid = req.body.amountPaid;
    if (Object.prototype.hasOwnProperty.call(req.body, 'amountsPaid')) {
      payment.amountsPaid = Array.isArray(req.body.amountsPaid) ? req.body.amountsPaid.slice(0, 4).map(v => Number(v) || 0) : [];
    }
    if (
      !Object.prototype.hasOwnProperty.call(req.body, 'trainingFee') &&
      Object.prototype.hasOwnProperty.call(req.body, 'amountPaid')
    ) {
      payment.trainingFee = req.body.amountPaid;
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'paymentRecord')) payment.paymentRecord = req.body.paymentRecord;
    if (Object.prototype.hasOwnProperty.call(req.body, 'concerns')) payment.concerns = req.body.concerns;
    if (Object.prototype.hasOwnProperty.call(req.body, 'highlightImageSlot')) {
      payment.highlightImageSlot = normalizeHighlightImageSlot(req.body.highlightImageSlot);
    }

    if (Object.prototype.hasOwnProperty.call(req.body, 'referenceNumbers')) {
      payment.referenceNumbers = normalizeReferenceSlots(req.body.referenceNumbers);
    }

    if (Object.prototype.hasOwnProperty.call(req.body, 'referenceNumber')) {
      payment.referenceNumber = req.body.referenceNumber;
    } else if (Array.isArray(payment.referenceNumbers) && payment.referenceNumbers.length) {
      payment.referenceNumber = getPrimarySlotValue(payment.referenceNumbers, payment.highlightImageSlot);
    }

    const refChanged = Object.prototype.hasOwnProperty.call(req.body, 'referenceNumber') ||
      Object.prototype.hasOwnProperty.call(req.body, 'referenceNumbers');
    if (Object.prototype.hasOwnProperty.call(req.body, 'referenceLabel') || refChanged) {
      payment.referenceLabel = await resolveReferenceLabel(
        payment.referenceNumber,
        Object.prototype.hasOwnProperty.call(req.body, 'referenceLabel') ? req.body.referenceLabel : payment.referenceLabel,
        payment._id,
        payment.referenceNumbers,
        refChanged ? previousRefs : undefined
      );
    }
    if (req.file) {
      payment.proofOfPayment = req.file.originalname;
      payment.proofOfPaymentImage = await saveImageBuffer({
        buffer: req.file.buffer,
        contentType: req.file.mimetype,
        originalName: req.file.originalname,
        source: 'manual-upload',
      });

      const currentSlots = normalizeReferenceSlots(Array.isArray(payment.proofOfPaymentImages) ? payment.proofOfPaymentImages : []);
      currentSlots[payment.highlightImageSlot - 1] = payment.proofOfPaymentImage;
      payment.proofOfPaymentImages = currentSlots;
    } else {
      if (Object.prototype.hasOwnProperty.call(req.body, 'proofOfPayment')) payment.proofOfPayment = req.body.proofOfPayment;
      if (Object.prototype.hasOwnProperty.call(req.body, 'proofOfPaymentImage')) {
        payment.proofOfPaymentImage = await normalizeImageValue(req.body.proofOfPaymentImage, payment.proofOfPayment);
      }
      if (Object.prototype.hasOwnProperty.call(req.body, 'proofOfPaymentImages')) {
        payment.proofOfPaymentImages = await normalizeImageSlots(req.body.proofOfPaymentImages, payment.proofOfPayment);
      }

      if (payment.proofOfPaymentImage && (!Array.isArray(payment.proofOfPaymentImages) || !payment.proofOfPaymentImages[payment.highlightImageSlot - 1])) {
        const slots = normalizeReferenceSlots(Array.isArray(payment.proofOfPaymentImages) ? payment.proofOfPaymentImages : []);
        slots[payment.highlightImageSlot - 1] = payment.proofOfPaymentImage;
        payment.proofOfPaymentImages = slots;
      }
    }

    if (!payment.proofOfPaymentImage) {
      payment.proofOfPaymentImage = getPrimarySlotValue(payment.proofOfPaymentImages || [], payment.highlightImageSlot);
    }

    const updatedPayment = await payment.save();

    if (previousImageMarker && previousImageMarker !== updatedPayment.proofOfPaymentImage) {
      await deleteStoredImageByMarker(previousImageMarker);
    }

    const retainedImages = new Set([
      updatedPayment.proofOfPaymentImage,
      ...(Array.isArray(updatedPayment.proofOfPaymentImages) ? updatedPayment.proofOfPaymentImages : []),
    ]);

    await Promise.all(
      previousImageMarkers
        .filter((marker) => marker && marker !== previousImageMarker)
        .filter((marker) => !retainedImages.has(marker))
        .map((marker) => deleteStoredImageByMarker(marker))
    );

    if (previousStatus !== 'Completed' && updatedPayment.paymentRecord === 'Completed') {
      sendPaymentVerifiedEmail(updatedPayment.email, {
        completeName: updatedPayment.completeName,
        amountPaid: updatedPayment.amountPaid,
        referenceNumber: updatedPayment.referenceNumber,
        enrollProgram: updatedPayment.enrollProgram,
      }).catch((err) => console.error('Failed to send payment verified email:', err.message));
    }

    res.json(updatedPayment);
  } catch (error) {
    if (error.name === 'CastError') {
      return res.status(400).json({ message: 'Invalid payment record ID' });
    }

    if (error.code === 11000) {
      return res.status(400).json({ message: 'Reference number already exists' });
    }

    res.status(400).json({ message: error.message });
  }
});

// ARCHIVE a payment record
router.patch('/:id/archive', async (req, res) => {
  try {
    const payment = await PaymentRecord.findById(req.params.id);
    if (!payment) {
      return res.status(404).json({ message: 'Payment record not found' });
    }
    payment.archived = true;
    await payment.save();
    res.json({ message: 'Payment record archived', id: req.params.id });
  } catch (error) {
    if (error.name === 'CastError') {
      return res.status(400).json({ message: 'Invalid payment record ID' });
    }
    res.status(500).json({ message: error.message });
  }
});

// UNARCHIVE a payment record
router.patch('/:id/unarchive', async (req, res) => {
  try {
    const payment = await PaymentRecord.findById(req.params.id);
    if (!payment) {
      return res.status(404).json({ message: 'Payment record not found' });
    }
    payment.archived = false;
    await payment.save();
    res.json({ message: 'Payment record unarchived', id: req.params.id });
  } catch (error) {
    if (error.name === 'CastError') {
      return res.status(400).json({ message: 'Invalid payment record ID' });
    }
    res.status(500).json({ message: error.message });
  }
});

// VALIDATE RECEIPT — mark a specific receipt slot as verified and send confirmation email
const SLOT_LABELS = ['1st Payment', '2nd Payment', '3rd Payment', '4th Payment'];

router.patch('/:id/validate-receipt', async (req, res) => {
  try {
    const { slot } = req.body;
    const slotNum = typeof slot === 'number' ? slot : 0;

    const payment = await PaymentRecord.findById(req.params.id);
    if (!payment) {
      return res.status(404).json({ message: 'Payment record not found' });
    }

    const alreadyVerified = payment.receiptVerifiedSlots.some(s => s.slot === slotNum);
    if (alreadyVerified) {
      return res.status(400).json({ message: 'This receipt is already verified' });
    }

    payment.receiptVerifiedSlots.push({ slot: slotNum, verifiedAt: new Date() });
    await payment.save();

    // Determine reference number for this slot
    const refNum = (Array.isArray(payment.referenceNumbers) && payment.referenceNumbers[slotNum])
      ? payment.referenceNumbers[slotNum]
      : payment.referenceNumber;

    const slotLabel = SLOT_LABELS[slotNum] || `Receipt ${slotNum + 1}`;

    // Send verification email (fire-and-forget so response isn't delayed)
    sendPaymentVerifiedEmail(payment.email, {
      completeName: payment.completeName,
      amountPaid: payment.amountPaid,
      referenceNumber: `${refNum} (${slotLabel})`,
      enrollProgram: payment.enrollProgram,
    }).catch(err => console.error('Failed to send receipt verification email:', err));

    res.json({ message: `Receipt (${slotLabel}) verified and email sent`, id: req.params.id, slot: slotNum });
  } catch (error) {
    if (error.name === 'CastError') {
      return res.status(400).json({ message: 'Invalid payment record ID' });
    }
    res.status(500).json({ message: error.message });
  }
});

// BULK ARCHIVE multiple payment records
router.patch('/archive', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: 'No IDs provided' });
    }
    const result = await PaymentRecord.updateMany(
      { _id: { $in: ids } },
      { $set: { archived: true } }
    );
    res.json({ message: `${result.modifiedCount} record(s) archived`, archivedCount: result.modifiedCount });
  } catch (error) {
    if (error.name === 'CastError') {
      return res.status(400).json({ message: 'One or more invalid payment record IDs' });
    }
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
