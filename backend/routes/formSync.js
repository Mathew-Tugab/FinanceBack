const express = require('express');
const router = express.Router();
const { google } = require('googleapis');
const PaymentRecord = require('../models/PaymentRecord');
const { fetchFormResponses } = require('../services/googleFormService');
const { saveImageBuffer } = require('../utils/imageStore');
const { authenticate } = require('../middleware/auth');
const { authorizeRoles } = require('../middleware/roles');
const { formSyncReadLimiter, formSyncWriteLimiter } = require('../middleware/rateLimiters');

// ---------------------------------------------------------------------------
// Shared helper: build an authenticated Drive client from .env credentials
// ---------------------------------------------------------------------------
function createDriveClient() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  const credentials = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
  return google.drive({ version: 'v3', auth });
}

router.use(authenticate);

// ---------------------------------------------------------------------------
// Downloads a Drive file and stores it in MongoDB.
// Returns { imageMarker, fileName } on success, throws on failure.
// ---------------------------------------------------------------------------
async function downloadDriveFile(driveApi, fileId) {
  const meta = await driveApi.files.get({
    fileId,
    fields: 'name,mimeType',
    supportsAllDrives: true,
  });

  const originalName = meta.data.name || `upload_${fileId}`;
  const mimeType = meta.data.mimeType || 'application/octet-stream';

  const fileRes = await driveApi.files.get(
    { fileId, alt: 'media', supportsAllDrives: true, acknowledgeAbuse: true },
    { responseType: 'stream' }
  );

  const chunks = [];
  await new Promise((resolve, reject) => {
    fileRes.data.on('data', (chunk) => chunks.push(chunk));
    fileRes.data.on('end', resolve);
    fileRes.data.on('error', reject);
  });

  const buffer = Buffer.concat(chunks);
  const imageMarker = await saveImageBuffer({
    buffer,
    contentType: mimeType,
    originalName,
    source: 'google-form',
  });

  return { imageMarker, fileName: originalName };
}

// ---------------------------------------------------------------------------
// Helper: extract a raw Drive file ID from any stored value
//   gdrive:FILE_ID  → FILE_ID
//   https://drive.google.com/uc?export=view&id=FILE_ID  → FILE_ID
//   https://drive.google.com/file/d/FILE_ID/view        → FILE_ID
// ---------------------------------------------------------------------------
function extractFileId(value) {
  if (!value) return null;
  if (value.startsWith('gdrive:')) return value.slice(7);
  const ucMatch = value.match(/[?&]id=([^&]+)/);
  if (ucMatch) return ucMatch[1];
  const fileMatch = value.match(/\/file\/d\/([^/]+)/);
  if (fileMatch) return fileMatch[1];
  return null;
}

function normalizeEmail(value) {
  if (!value || typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}

function appendUniqueResponseIds(record, ids = []) {
  const incoming = ids.filter(Boolean);
  if (!incoming.length) return false;

  const existing = new Set([
    ...((Array.isArray(record.formResponseIds) ? record.formResponseIds : []).filter(Boolean)),
    record.formResponseId || '',
  ]);

  let changed = false;
  const next = Array.isArray(record.formResponseIds) ? [...record.formResponseIds] : [];
  for (const id of incoming) {
    if (!existing.has(id)) {
      next.push(id);
      existing.add(id);
      changed = true;
    }
  }

  if (changed) {
    record.formResponseIds = next;
  }

  return changed;
}

function getInstallmentSlot(paymentInstallment = '') {
  const normalized = String(paymentInstallment || '').trim().toLowerCase();
  if (!normalized) return 1;

  if (normalized.includes('remaining balance') || normalized.includes('remainingbalance')) return 2;
  if (normalized.includes('follow up') || normalized.includes('followup')) return 2;

  if (normalized.includes('4th') || normalized.includes('fourth') || normalized.includes('four')) return 4;
  if (normalized.includes('3rd') || normalized.includes('third') || normalized.includes('three')) return 3;
  if (normalized.includes('2nd') || normalized.includes('second') || normalized.includes('two')) return 2;
  if (normalized.includes('1st') || normalized.includes('first') || normalized.includes('one')) return 1;

  const numericMatch = normalized.match(/([1-4])/);
  if (!numericMatch) return 1;
  const parsed = Number(numericMatch[1]);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(4, parsed)) : 1;
}

function ensureFourSlots(values) {
  const slots = Array.isArray(values)
    ? values.slice(0, 4).map((value) => (typeof value === 'string' ? value : ''))
    : [];
  while (slots.length < 4) slots.push('');
  return slots;
}

/**
 * Recheck and update the referenceLabel on a record by scanning ALL its
 * reference numbers (primary + slots) against every other record in the DB.
 * Also flags other 'Auto'-labelled records that share any of those references.
 * Mutates `record.referenceLabel` in place (caller must still .save()).
 */
async function recheckReferenceLabel(record) {
  // Allow re-evaluation for both 'Auto' and 'Repeated Reference Number'
  // Manual overrides ('None', 'Group Payment') are kept as-is
  if (record.referenceLabel && record.referenceLabel !== 'Auto' && record.referenceLabel !== 'Repeated Reference Number') return;

  const allRefs = new Set();
  const primary = (record.referenceNumber || '').trim().toUpperCase();
  if (primary) allRefs.add(primary);
  if (Array.isArray(record.referenceNumbers)) {
    for (const ref of record.referenceNumbers) {
      const normalized = (ref || '').trim().toUpperCase();
      if (normalized) allRefs.add(normalized);
    }
  }
  if (allRefs.size === 0) {
    if (record.referenceLabel === 'Repeated Reference Number') record.referenceLabel = 'Auto';
    return;
  }

  const regexPatterns = [...allRefs].map(
    (ref) => new RegExp(`^${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')
  );

  const filter = {
    _id: { $ne: record._id },
    $or: [
      { referenceNumber: { $in: regexPatterns } },
      { referenceNumbers: { $in: regexPatterns } },
    ],
  };

  const dupCount = await PaymentRecord.countDocuments(filter);
  if (dupCount > 0) {
    record.referenceLabel = 'Repeated Reference Number';
    await PaymentRecord.updateMany(
      { ...filter, referenceLabel: 'Auto' },
      { $set: { referenceLabel: 'Repeated Reference Number' } }
    );
  } else {
    // No duplicates — downgrade back to Auto
    record.referenceLabel = 'Auto';
  }
}

function getSlotFromImageSlots(values) {
  const slots = ensureFourSlots(values);
  const foundIndex = slots.findIndex((value) => typeof value === 'string' && value.trim().length > 0);
  return foundIndex >= 0 ? foundIndex + 1 : null;
}

function applySlotFields(record, { slot, imageUrl, imageName, referenceNumber, paymentInstallment, backfillOnly = false }) {
  const slotIndex = Math.max(1, Math.min(4, Number(slot) || 1)) - 1;
  let changed = false;

  const imageSlots = ensureFourSlots(record.proofOfPaymentImages);
  if (imageUrl && imageSlots[slotIndex] !== imageUrl) {
    // In backfillOnly mode, only fill empty slots
    if (!backfillOnly || !imageSlots[slotIndex]) {
      imageSlots[slotIndex] = imageUrl;
      changed = true;
    }
  }
  record.proofOfPaymentImages = imageSlots;

  if (imageUrl && record.proofOfPaymentImage !== imageUrl) {
    // In backfillOnly mode, only set if currently empty
    if (!backfillOnly || !record.proofOfPaymentImage) {
      record.proofOfPaymentImage = imageUrl;
      changed = true;
    }
  }

  if (imageName && record.proofOfPayment !== imageName) {
    if (!backfillOnly || !record.proofOfPayment) {
      record.proofOfPayment = imageName;
      changed = true;
    }
  }

  const referenceSlots = ensureFourSlots(record.referenceNumbers);
  if (referenceNumber && referenceSlots[slotIndex] !== referenceNumber) {
    if (!backfillOnly || !referenceSlots[slotIndex]) {
      referenceSlots[slotIndex] = referenceNumber;
      changed = true;
    }
  }
  record.referenceNumbers = referenceSlots;

  if (referenceNumber && record.referenceNumber !== referenceNumber) {
    if (!backfillOnly || !record.referenceNumber) {
      record.referenceNumber = referenceNumber;
      changed = true;
    }
  }

  const normalizedSlot = slotIndex + 1;
  if (record.highlightImageSlot !== normalizedSlot) {
    if (!backfillOnly) {
      record.highlightImageSlot = normalizedSlot;
      changed = true;
    }
  }

  if (paymentInstallment && record.paymentInstallment !== paymentInstallment) {
    if (!backfillOnly || !record.paymentInstallment) {
      record.paymentInstallment = paymentInstallment;
      changed = true;
    }
  }

  return changed;
}

function appendFollowUpPaymentEntry(record, payload) {
  const slot = Math.max(1, Math.min(4, Number(payload?.slot) || 1));
  if (slot <= 1) return false;

  const responseId = String(payload?.formResponseId || '').trim();
  const referenceNumber = String(payload?.referenceNumber || '').trim();
  const amountPaid = Number(payload?.amountPaid) || 0;
  const proofOfPaymentImage = String(payload?.proofOfPaymentImage || '').trim();
  const paymentInstallment = String(payload?.paymentInstallment || '').trim();
  const submittedAt = payload?.submittedAt ? new Date(payload.submittedAt) : new Date();

  const existing = Array.isArray(record.followUpPayments) ? [...record.followUpPayments] : [];

  const duplicate = existing.some((entry) => {
    if (responseId && String(entry?.formResponseId || '').trim() === responseId) return true;
    return (
      Number(entry?.slot || 0) === slot &&
      String(entry?.referenceNumber || '').trim() === referenceNumber &&
      Number(entry?.amountPaid || 0) === amountPaid &&
      String(entry?.proofOfPaymentImage || '').trim() === proofOfPaymentImage
    );
  });

  if (duplicate) return false;

  existing.push({
    slot,
    paymentInstallment,
    referenceNumber,
    amountPaid,
    proofOfPaymentImage,
    formResponseId: responseId,
    submittedAt,
  });

  record.followUpPayments = existing;
  return true;
}

// ---------------------------------------------------------------------------
// GET /api/form-sync/drive-image/:fileId
//   Proxy endpoint – streams the Drive file through the service account so
//   the browser can display it without any auth or CORS issues.
// ---------------------------------------------------------------------------
router.get('/drive-image/:fileId', formSyncReadLimiter, async (req, res) => {
  try {
    const { fileId } = req.params;
    if (!fileId) return res.status(400).json({ message: 'Missing fileId' });

    const driveApi = createDriveClient();

    // Get MIME type first (supportsAllDrives covers files in shared/form-upload folders)
    const meta = await driveApi.files.get({
      fileId,
      fields: 'mimeType, name',
      supportsAllDrives: true,
    });
    const mimeType = meta.data.mimeType || 'image/jpeg';

    // Stream the file directly to the response
    const fileRes = await driveApi.files.get(
      { fileId, alt: 'media', supportsAllDrives: true, acknowledgeAbuse: true },
      { responseType: 'stream' }
    );

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Cache-Control', 'public, max-age=86400'); // cache 24h
    fileRes.data.on('error', (streamErr) => {
      console.error('Drive stream error:', streamErr.message);
      if (!res.headersSent) res.status(500).json({ message: streamErr.message });
    });
    fileRes.data.pipe(res);
  } catch (err) {
    console.error('Drive image proxy error:', err.message);
    res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/form-sync/preview
//   Fetch responses from Google Forms without saving anything.
//   Useful for checking what will be imported before committing.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/preview', authorizeRoles('admin'), formSyncReadLimiter, async (req, res) => {
  try {
    const { formTitle, totalResponses, records, formIds, formTitles, formErrors } = await fetchFormResponses();

    // Only load references present in this preview payload to avoid full-collection scans in memory.
    const incomingRefs = [...new Set(records.map((r) => (r.referenceNumber || '').trim()).filter(Boolean))];
    const existingRefs = incomingRefs.length > 0
      ? new Set((await PaymentRecord.find({ referenceNumber: { $in: incomingRefs } }, 'referenceNumber').lean()).map((p) => p.referenceNumber))
      : new Set();

    const preview = records.map((r) => ({
      ...r,
      _alreadyExists: r.referenceNumber ? existingRefs.has(r.referenceNumber) : false,
    }));

    res.json({
      formTitle,
      formIds,
      formTitles,
      totalResponses,
      newRecords: preview.filter((r) => !r._alreadyExists).length,
      duplicates: preview.filter((r) => r._alreadyExists).length,
      warnings: formErrors || [],
      records: preview,
    });
  } catch (error) {
    console.error('Form preview error:', error);
    res.status(500).json({ message: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/form-sync/sync
//   Fetch form responses and save new ones to MongoDB.
//   Skips entries whose referenceNumber already exists (idempotent).
// ─────────────────────────────────────────────────────────────────────────────
router.post('/sync', authorizeRoles('admin'), formSyncWriteLimiter, async (req, res) => {
  try {
    const { records, formErrors } = await fetchFormResponses({ bypassCache: true });
    const driveApi = createDriveClient();
    const seenResponseIds = new Set();

    const results = {
      saved: [],
      skipped: [],
      failed: [],
    };

    // ── Phase 1: pre-load all existing records as full Mongoose docs ────────
    // Loading full documents (no .lean()) lets us update them directly in Phase 3
    // without individual findById round-trips to the database.
    const allExisting = await PaymentRecord.find({});

    // _id string → Mongoose document (for direct access without findById)
    const docById = new Map();
    // responseId → string _id
    const byResponseId = new Map();
    // normalizedEmail → [doc, ...]
    const byEmailList  = new Map();
    // `ref|name|amtPaid|fee` → string _id  (fingerprint dedup)
    const byFingerprint = new Map();
    // `ref|name` → [doc, ...] for legacy records that have no formResponseId
    const byLegacyKey  = new Map();

    for (const rec of allExisting) {
      const idStr = rec._id.toString();
      docById.set(idStr, rec);

      const ids = [
        rec.formResponseId,
        ...(Array.isArray(rec.formResponseIds) ? rec.formResponseIds : []),
      ].filter(Boolean);
      for (const id of ids) byResponseId.set(id, idStr);

      const ek = normalizeEmail(rec.email);
      if (ek && ek !== 'noemail@form.local') {
        if (!byEmailList.has(ek)) byEmailList.set(ek, []);
        byEmailList.get(ek).push(rec);
      }

      byFingerprint.set(
        `${rec.referenceNumber}|${rec.completeName}|${Number(rec.amountPaid)}|${Number(rec.trainingFee)}`,
        idStr
      );

      if (!rec.formResponseId) {
        const lk = `${rec.referenceNumber}|${rec.completeName}`;
        if (!byLegacyKey.has(lk)) byLegacyKey.set(lk, []);
        byLegacyKey.get(lk).push(rec);
      }
    }

    for (const [, list] of byEmailList) {
      list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    }

    function addToEmailIndex(normalizedEmail, record) {
      if (!normalizedEmail || normalizedEmail === 'noemail@form.local') return;
      if (!byEmailList.has(normalizedEmail)) {
        byEmailList.set(normalizedEmail, [record]);
        return;
      }
      byEmailList.get(normalizedEmail).unshift(record);
    }

    // Helper: sorted-newest-first records for a normalised email
    function getEmailRecords(normalizedEmail) {
      return byEmailList.get(normalizedEmail) || [];
    }

    // ── Phase 2: parallel Drive image downloads ─────────────────────────────
    // Collect every unique Drive file ID referenced across all incoming records,
    // then download them in parallel batches of 5 instead of one-at-a-time.
    const driveFileIds = new Set();
    for (const r of records) {
      const slots = ensureFourSlots(Array.isArray(r.proofOfPaymentImages) ? r.proofOfPaymentImages : []);
      for (const slot of slots) {
        if (slot && slot.startsWith('gdrive:')) driveFileIds.add(slot.slice(7));
      }
      const fb = r.proofOfPaymentImage || '';
      if (fb.startsWith('gdrive:')) driveFileIds.add(fb.slice(7));
    }

    const driveCache = new Map(); // fileId → { imageMarker, fileName }
    const DRIVE_CONCURRENCY = 10;
    const fileIdArray = [...driveFileIds];
    for (let i = 0; i < fileIdArray.length; i += DRIVE_CONCURRENCY) {
      const batch = fileIdArray.slice(i, i + DRIVE_CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map(async (fileId) => {
          const result = await downloadDriveFile(driveApi, fileId);
          return { fileId, ...result };
        })
      );
      for (const item of settled) {
        if (item.status === 'fulfilled') {
          driveCache.set(item.value.fileId, {
            imageMarker: item.value.imageMarker,
            fileName:    item.value.fileName,
          });
          console.log(`Downloaded Drive file ${item.value.fileId} → ${item.value.imageMarker}`);
        } else {
          console.warn(`Could not download Drive file: ${item.reason?.message}`);
        }
      }
    }

    // ── Phase 3: main processing loop (all lookups now in-memory) ──────────
    for (const r of records) {
      // ── Fallbacks so we never silently drop a response ──────────────────
      const formResponseId = (r._formResponseId || '').trim() || null;
      const rawResponseId = formResponseId && formResponseId.includes(':')
        ? formResponseId.split(':').slice(1).join(':')
        : formResponseId;
      const candidateResponseIds = [...new Set([formResponseId, rawResponseId].filter(Boolean))];
      const referenceNumber = (r.referenceNumber || '').trim() || `FORM-${r._formResponseId}`;
      const completeName = (r.completeName || '').trim() || 'Unknown Respondent';
      const email        = (r.email || '').trim() || 'noemail@form.local';
      const normalizedEmail = normalizeEmail(email);
      const enrollProgram = (r.enrollProgram || '').trim();
      const paymentInstallment = (r.paymentInstallment || '').trim();
      const installmentSlot = getInstallmentSlot(paymentInstallment) || getSlotFromImageSlots(r.proofOfPaymentImages) || 1;
      const trainingFee = Number.isFinite(Number(r.trainingFee)) ? Number(r.trainingFee) : (Number(r.amountPaid) || 0);
      const amountPaid = Number.isFinite(Number(r.amountPaid)) ? Number(r.amountPaid) : trainingFee;

      const incomingImageSlots = ensureFourSlots(Array.isArray(r.proofOfPaymentImages) ? r.proofOfPaymentImages : []);
      const fallbackImage = r.proofOfPaymentImage || '';
      const rawImageForSlot = incomingImageSlots[installmentSlot - 1] || fallbackImage || incomingImageSlots.find(Boolean) || '';

      const syncSeenKey = candidateResponseIds[0] || `${referenceNumber}|${completeName}|${trainingFee}|${amountPaid}`;
      if (seenResponseIds.has(syncSeenKey)) {
        results.skipped.push({
          formResponseId: formResponseId || '',
          reason: 'Duplicate entry detected in current sync batch',
        });
        continue;
      }
      seenResponseIds.add(syncSeenKey);

      // ── Resolve Drive image from pre-downloaded cache ───────────────────
      let imageUrl  = rawImageForSlot;
      let imageName = r.proofOfPayment || 'Form Upload';

      if (imageUrl.startsWith('gdrive:')) {
        const fileId = imageUrl.slice(7);
        const cached = driveCache.get(fileId);
        if (cached) {
          imageUrl  = cached.imageMarker;
          imageName = cached.fileName;
        } else {
          console.warn(`Drive file ${fileId} not in cache — keeping gdrive fallback marker`);
        }
      }

      // ── Idempotency: skip if this exact Google response already synced ──
      if (formResponseId) {
        const matchedId = candidateResponseIds.find((id) => byResponseId.has(id));
        if (matchedId) {
          const existingByResponseId = docById.get(byResponseId.get(matchedId));
          if (existingByResponseId) {
            let updated = false;
            if (existingByResponseId.formResponseId !== formResponseId && formResponseId) {
              existingByResponseId.formResponseId = formResponseId;
              updated = true;
            }
            if (!existingByResponseId.formSource && r._formTitle) {
              existingByResponseId.formSource = r._formTitle;
              updated = true;
            }
            if (appendUniqueResponseIds(existingByResponseId, candidateResponseIds)) updated = true;
            if (applySlotFields(existingByResponseId, {
              slot: installmentSlot, imageUrl, imageName, referenceNumber, paymentInstallment, backfillOnly: true,
            })) updated = true;
            if (appendFollowUpPaymentEntry(existingByResponseId, {
              slot: installmentSlot, paymentInstallment, referenceNumber, amountPaid,
              proofOfPaymentImage: imageUrl, formResponseId, submittedAt: r.submittedAt,
            })) updated = true;
            if (updated) {
              await recheckReferenceLabel(existingByResponseId);
              await existingByResponseId.save();
            }
            results.skipped.push({
              formResponseId,
              reason: updated
                ? `Form response "${formResponseId}" already synced (updated missing fields)`
                : `Form response "${formResponseId}" already synced`,
            });
            continue;
          }
        }

        // Legacy backfill: records synced before formResponseId existed —
        // use in-memory index keyed by referenceNumber|completeName
        const legacyKey = `${referenceNumber}|${completeName}`;
        const legacyCandidates = (byLegacyKey.get(legacyKey) || []).filter((rec) => {
          const amt = Number(rec.amountPaid);
          return amt === trainingFee || amt === amountPaid;
        });
        const legacyMatch = legacyCandidates.sort(
          (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
        )[0];

        if (legacyMatch) {
          const legacyRecord = legacyMatch;
          if (legacyRecord) {
            const currentEnroll    = (legacyRecord.enrollProgram || '').trim();
            const currentEmail     = (legacyRecord.email || '').trim().toLowerCase();
            const newEmail         = email.trim().toLowerCase();
            const needsEnrollBackfill    = !currentEnroll && enrollProgram;
            const needsEmailBackfill     = !!newEmail && newEmail !== 'noemail@form.local' &&
              (!currentEmail || currentEmail === 'noemail@form.local');
            const needsTrainingFeeBackfill = !Number(legacyRecord.trainingFee) && !!trainingFee;
            const needsAmountPaidBackfill  = !Number(legacyRecord.amountPaid)  && !!amountPaid;
            legacyRecord.formResponseId = formResponseId;
            appendUniqueResponseIds(legacyRecord, candidateResponseIds);
            applySlotFields(legacyRecord, {
              slot: installmentSlot, imageUrl, imageName, referenceNumber, paymentInstallment, backfillOnly: true,
            });
            appendFollowUpPaymentEntry(legacyRecord, {
              slot: installmentSlot, paymentInstallment, referenceNumber, amountPaid,
              proofOfPaymentImage: imageUrl, formResponseId, submittedAt: r.submittedAt,
            });
            if (needsEnrollBackfill)    legacyRecord.enrollProgram = enrollProgram;
            if (needsEmailBackfill)     legacyRecord.email         = email;
            if (needsTrainingFeeBackfill) legacyRecord.trainingFee = trainingFee;
            if (needsAmountPaidBackfill)  legacyRecord.amountPaid  = amountPaid;
            if (!legacyRecord.formSource && r._formTitle) legacyRecord.formSource = r._formTitle;
            await recheckReferenceLabel(legacyRecord);
            await legacyRecord.save();
            // update in-memory index so later records in this batch can see it
            for (const id of candidateResponseIds) byResponseId.set(id, legacyRecord._id.toString());
            results.skipped.push({ formResponseId, reason: 'Matched existing record and backfilled response ID' });
            continue;
          }
        }
      }

      // ── Follow-up payment merge by email (in-memory) ────────────────────
      const canMergeByEmail = normalizedEmail && normalizedEmail !== 'noemail@form.local';
      if (canMergeByEmail) {
        // Decision: is this a follow-up payment or a brand-new enrollment?
        //
        // Follow-up  (slot > 1, e.g. 2nd/3rd/4th / Remaining Balance):
        //   → Always merge into the most-recent matching record for this email,
        //     preferring the same program but accepting any if none matches.
        //
        // New enrollment (slot === 1):
        //   → Only merge if the existing record has the *same* (or blank) program.
        //     A different program means a separate enrollment → let it fall through
        //     to "Save new record" below.
        const isFollowUp = installmentSlot > 1;
        const emailRecs  = getEmailRecords(normalizedEmail);
        let existingByEmailLean = null;

        if (isFollowUp) {
          existingByEmailLean = (enrollProgram
            ? emailRecs.find((rec) => rec.enrollProgram === enrollProgram)
            : null) || emailRecs[0] || null;
        } else {
          if (enrollProgram) {
            existingByEmailLean = emailRecs.find((rec) => rec.enrollProgram === enrollProgram)
              || emailRecs.find((rec) => !rec.enrollProgram)
              || null;
          } else {
            existingByEmailLean = emailRecs[0] || null;
          }
        }

        if (existingByEmailLean) {
          const hasThisResponseAlready =
            (!!formResponseId && existingByEmailLean.formResponseId === formResponseId) ||
            (candidateResponseIds.length > 0 &&
              Array.isArray(existingByEmailLean.formResponseIds) &&
              candidateResponseIds.some((id) => (existingByEmailLean.formResponseIds || []).includes(id)));

          if (hasThisResponseAlready) {
            results.skipped.push({
              formResponseId: formResponseId || '',
              reason: 'Follow-up response already merged for this email',
            });
            continue;
          }

          const existingByEmail = existingByEmailLean;
          if (existingByEmail) {
            existingByEmail.amountPaid = Number(existingByEmail.amountPaid || 0) + amountPaid;
            if (!Number(existingByEmail.trainingFee) && trainingFee) existingByEmail.trainingFee = trainingFee;
            if (!(existingByEmail.enrollProgram || '').trim() && enrollProgram) existingByEmail.enrollProgram = enrollProgram;
            applySlotFields(existingByEmail, {
              slot: installmentSlot, imageUrl, imageName, referenceNumber, paymentInstallment,
            });
            appendFollowUpPaymentEntry(existingByEmail, {
              slot: installmentSlot, paymentInstallment, referenceNumber, amountPaid,
              proofOfPaymentImage: imageUrl, formResponseId, submittedAt: r.submittedAt,
            });
            appendUniqueResponseIds(existingByEmail, candidateResponseIds);
            if (!existingByEmail.formSource && r._formTitle) existingByEmail.formSource = r._formTitle;
            await recheckReferenceLabel(existingByEmail);
            await existingByEmail.save();
            // update in-memory indexes for subsequent records in this batch
            for (const id of candidateResponseIds) byResponseId.set(id, existingByEmail._id.toString());
            results.saved.push({
              id: existingByEmail._id,
              referenceNumber: existingByEmail.referenceNumber,
              completeName: existingByEmail.completeName,
            });
            continue;
          }
        }
      }

      // ── Fingerprint dedup (in-memory) ──────────────────────────────────
      const fp = `${referenceNumber}|${completeName}|${amountPaid}|${trainingFee}`;
      if (byFingerprint.has(fp)) {
        results.skipped.push({
          formResponseId: formResponseId || '',
          reason: 'Likely duplicate record already exists',
        });
        continue;
      }

      // ── Resolve reference label for duplicates ─────────────────────────
      // Handled by recheckReferenceLabel after constructing the record below.

      // ── Save new record ─────────────────────────────────────────────────
      try {
        const newPayment = new PaymentRecord({
          email,
          completeName,
          enrollProgram,
          trainingFee,
          amountPaid,
          paymentRecord:       r.paymentRecord || 'Pending',
          concerns:            r.concerns || 'None',
          referenceNumber,
          referenceLabel:      r.referenceLabel || 'Auto',
          formResponseId,
          formResponseIds: candidateResponseIds,
          formSource:          r._formTitle || '',
          paymentInstallment,
          proofOfPayment:      imageName,
          proofOfPaymentImage: imageUrl,
          proofOfPaymentImages: (() => {
            const slots = ensureFourSlots([]);
            slots[installmentSlot - 1] = imageUrl;
            return slots;
          })(),
          highlightImageSlot: installmentSlot,
          referenceNumbers: (() => {
            const slots = ensureFourSlots([]);
            slots[installmentSlot - 1] = referenceNumber;
            return slots;
          })(),
          followUpPayments: installmentSlot > 1
            ? [{
              slot: installmentSlot,
              paymentInstallment,
              referenceNumber,
              amountPaid,
              proofOfPaymentImage: imageUrl,
              formResponseId: formResponseId || '',
              submittedAt: r.submittedAt || new Date().toISOString(),
            }]
            : [],
        });

        // Recheck reference label against entire DB (all fields + slots)
        await recheckReferenceLabel(newPayment);
        const saved = await newPayment.save();

        // Update in-memory indexes so subsequent records in this batch can match against this new one
        const savedIdStr = saved._id.toString();
        docById.set(savedIdStr, saved);
        for (const id of candidateResponseIds) byResponseId.set(id, savedIdStr);
        const ek = normalizeEmail(email);
        addToEmailIndex(ek, saved);
        byFingerprint.set(fp, savedIdStr);

        results.saved.push({
          id: saved._id,
          referenceNumber: saved.referenceNumber,
          completeName: saved.completeName,
        });
      } catch (saveErr) {
        results.failed.push({
          formResponseId: r._formResponseId,
          reason: saveErr.message,
          data: r,
        });
      }
    }

    res.json({
      message: `Sync complete. Saved: ${results.saved.length}, Skipped: ${results.skipped.length}, Failed: ${results.failed.length}`,
      saved: results.saved.length,
      skipped: results.skipped.length,
      failed: results.failed.length,
      warnings: formErrors || [],
      details: results,
    });
  } catch (error) {
    console.error('Form sync error:', error);
    res.status(500).json({ message: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/form-sync/health
//   Quick test to confirm Google Forms API access is working.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/health', authorizeRoles('admin'), formSyncReadLimiter, async (req, res) => {
  try {
    const { formTitle, totalResponses, formIds, formTitles, formErrors } = await fetchFormResponses();
    res.json({
      status: 'ok',
      formTitle,
      formIds,
      formTitles,
      totalResponses,
      warnings: formErrors || [],
      message: 'Google Forms API connection is working',
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/form-sync/debug
//   Shows every question title from the form and which field it mapped to.
//   Also shows the first response as a sample so you can verify values.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/debug', authorizeRoles('admin'), formSyncReadLimiter, async (req, res) => {
  try {
    const { formTitle, totalResponses, records, rawItems, formIds, formTitles, formErrors } = await fetchFormResponses();
    res.json({
      formTitle,
      formIds,
      formTitles,
      totalResponses,
      warnings: formErrors || [],
      questionMapping: rawItems,
      sampleRecord: records[0] || null,
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

module.exports = router;
