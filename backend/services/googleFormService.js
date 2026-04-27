const { google } = require('googleapis');

const DEFAULT_CACHE_TTL_MS = Number(process.env.GOOGLE_FORM_FETCH_CACHE_TTL_MS || 30_000);
const formResponseCache = new Map();

// NOTE: FORM_ID is intentionally read inside each function (not cached at
// module load) so that changes to .env + server restart are always honoured.

// ---------------------------------------------------------------------------
// Auth – uses the service‑account JSON stored in GOOGLE_SERVICE_ACCOUNT_KEY
// ---------------------------------------------------------------------------
function getAuthClient() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY is not set in .env');

  let credentials;
  try {
    credentials = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON');
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: [
      'https://www.googleapis.com/auth/forms.responses.readonly',
      'https://www.googleapis.com/auth/forms.body.readonly',
      'https://www.googleapis.com/auth/drive',        // needed to read & share uploaded files
    ],
  });

  return auth;
}

// ---------------------------------------------------------------------------
// Returns a gdrive:FILE_ID marker. The actual image is served via the
// backend proxy endpoint /api/form-sync/drive-image/:fileId which streams
// it through the service account. During sync, this marker is converted into
// a MongoDB-backed dbimg:IMAGE_ID marker.
// ---------------------------------------------------------------------------
function getDriveImageMarker(fileId) {
  if (!fileId) return '';
  return `gdrive:${fileId}`;
}

// Custom display names for each Google Form (keyed by form ID).
// Forms not listed here fall back to their Google Form title.
const FORM_DISPLAY_NAMES = {
  '1b4WXx2fCsbwG2XRuVfWliaNg44u-AgAhwoaPzgm4xSA': 'CE Box',
  '1uZUOED-0khuyL5jW-6X9LHoNIPu92GEdh7DAprmMUV8': 'Kent',
  '1IgV8dUGJ-ZbakHCZojg_aeei2F8skKZEankHn0eC6jU': 'SO3',
  '18QZLtwro4GNxEsfdWbuX5x2RMwnZNH9GH6koCoSSXGU': 'SIBIL',
  '1Wp-iZgdkEyE5fPh2CQEu1lI8UXEk9RzHSdcQFDc4jB0': 'PUBLIC',
  '1qZzq35WfMe9ClLK1WnQaUdi9ji2WlEJ1UvPfoon3FF8': 'TEST',
};

function getFormIds() {
  const raw = process.env.GOOGLE_FORM_IDS || process.env.GOOGLE_FORM_ID || '';
  const ids = raw
    .split(/[\n,;]+/)
    .map((id) => id.trim().replace(/^['\"]+|['\"]+$/g, ''))
    .filter(Boolean);

  if (ids.length === 0) {
    throw new Error('GOOGLE_FORM_ID or GOOGLE_FORM_IDS is not set in .env');
  }

  return ids;
}

// ---------------------------------------------------------------------------
// Normalise a question title so it can be matched against known field names
// ---------------------------------------------------------------------------
function normalise(str) {
  return str.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function getInstallmentSlotFromText(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return null;

  if (normalized.includes('remaining balance') || normalized.includes('remainingbalance')) return 2;
  if (normalized.includes('follow up') || normalized.includes('followup')) return 2;

  if (normalized.includes('4th') || normalized.includes('fourth') || normalized.includes('four')) return 4;
  if (normalized.includes('3rd') || normalized.includes('third') || normalized.includes('three')) return 3;
  if (normalized.includes('2nd') || normalized.includes('second') || normalized.includes('two')) return 2;
  if (normalized.includes('1st') || normalized.includes('first') || normalized.includes('one')) return 1;

  const match = normalized.match(/([1-4])/);
  if (!match) return null;

  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(1, Math.min(4, parsed));
}

function ensureFourSlots(values = []) {
  const slots = Array.isArray(values)
    ? values.slice(0, 4).map((value) => (typeof value === 'string' ? value : ''))
    : [];
  while (slots.length < 4) slots.push('');
  return slots;
}

const FIELD_MATCHERS = {
  email:           ['email', 'emailaddress', 'emailad', 'mail', 'gmail'],
  completeName:    [
    'completename', 'fullname', 'name', 'yourname', 'studentname',
    'firstname', 'lastname', 'student', 'membername', 'member',
    'completoname', 'nombrecompleto',
  ],
  trainingFee:     [
    'trainingfee', 'enrollmentfee', 'coursefee', 'programfee', 'tuitionfee',
    'amountdue', 'feeamount', 'registrationfee',
  ],
  amountPaid:      [
    'amountpaid', 'totalpaid', 'paidamount', 'paymentmade', 'paymentamount',
    'amountyoupaid', 'totalpayment', 'howmuchpaid',
  ],
  enrollProgram:   [
    'whatwillyouenroll', 'whatwillyouenrollin', 'whatwillyouenrollfor',
    'enroll', 'enrollment', 'enrollprogram', 'program', 'course',
    'trainingprogram', 'typeoftraining', 'batchnumber',
  ],
  paymentInstallment: [
    'paymentinstallment', 'installment', 'installmentnumber', 'paymentnumber',
    'whichpayment', 'nthpayment', 'followuppayment', 'secondpayment',
    'thirdpayment', 'fourthpayment', 'paymentclassification',
  ],
  referenceNumber: [
    'referencenumber', 'reference', 'referenceno', 'referencecode',
    'transactionreference', 'paymentreference',
  ],
};

function matchField(title) {
  const n = normalise(title);
  for (const [field, patterns] of Object.entries(FIELD_MATCHERS)) {
    for (const pattern of patterns) {
      if (n.includes(pattern)) return field;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fetch the form structure (questions) and build a questionId → fieldName map
// Also returns raw items for debugging
// ---------------------------------------------------------------------------
async function fetchFormStructure(formsApi, formId) {
  const res = await formsApi.forms.get({ formId });
  const form = res.data;

  const map = {}; // questionId → fieldName
  const questionTitleMap = {}; // questionId → title
  const rawItems = []; // for debug endpoint

  for (const item of form.items || []) {
    const questionId = item.questionItem?.question?.questionId;
    const title = item.title || '';
    if (!questionId) continue;

    questionTitleMap[questionId] = title;

    const field = matchField(title);
    rawItems.push({ formId, questionId, title, matchedField: field || '(unmapped)' });

    if (field) map[questionId] = field;
  }

  return { map, questionTitleMap, formTitle: FORM_DISPLAY_NAMES[formId] || form.info?.title || 'Untitled Form', rawItems };
}

function cloneFetchResult(result) {
  return {
    ...result,
    records: Array.isArray(result.records) ? result.records.map((record) => ({ ...record })) : [],
    rawItems: Array.isArray(result.rawItems) ? result.rawItems.map((item) => ({ ...item })) : [],
    formIds: Array.isArray(result.formIds) ? [...result.formIds] : [],
    formTitles: Array.isArray(result.formTitles) ? [...result.formTitles] : [],
    formErrors: Array.isArray(result.formErrors) ? result.formErrors.map((item) => ({ ...item })) : [],
  };
}

// ---------------------------------------------------------------------------
// Fetch all responses and map them to PaymentRecord‑shaped objects
// ---------------------------------------------------------------------------
async function fetchFormResponses(options = {}) {
  const { bypassCache = false } = options;
  const formIds = getFormIds();
  const cacheKey = formIds.join('|');

  if (!bypassCache) {
    const cached = formResponseCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cloneFetchResult(cached.value);
    }
  }

  const auth = getAuthClient();
  const formsApi = google.forms({ version: 'v1', auth });
  // Note: Drive file downloads happen in the sync route, not here,
  // so this service stays fast for preview / health / debug calls too.

  const records = [];
  const rawItems = [];
  const formTitles = [];
  const formErrors = [];
  let totalResponses = 0;

  // Fetch all forms in parallel instead of sequentially
  const formResults = await Promise.allSettled(
    formIds.map(async (formId) => {
      const { map, questionTitleMap, formTitle, rawItems: formRawItems } = await fetchFormStructure(formsApi, formId);

      let allResponses = [];
      let nextPageToken;

      do {
        const params = { formId, pageSize: 500 };
        if (nextPageToken) params.pageToken = nextPageToken;

        const res = await formsApi.forms.responses.list(params);
        allResponses = allResponses.concat(res.data.responses || []);
        nextPageToken = res.data.nextPageToken;
      } while (nextPageToken);

      const formRecords = allResponses.map((r) => {
        const base = {
          _formResponseId: `${formId}:${r.responseId}`,
          _formTitle: formTitle,
          submittedAt: r.lastSubmittedTime,
          email: (r.respondentEmail || '').trim(),
          completeName: '',
          trainingFee: 0,
          amountPaid: 0,
          enrollProgram: '',
          paymentInstallment: '',
          referenceNumber: '',
          proofOfPayment: '',
          proofOfPaymentImage: '',
          proofOfPaymentImages: [],
          concerns: 'None',
          paymentRecord: 'Pending',
        };

        for (const [questionId, answer] of Object.entries(r.answers || {})) {
          // ── File upload answer (handle even when question title is unmapped) ──
          if (answer.fileUploadAnswers) {
            const uploadAnswers = answer.fileUploadAnswers?.answers || [];
            const fileIds = uploadAnswers
              .map((entry) => entry?.fileId || '')
              .filter(Boolean);

            if (fileIds.length) {
              const imageMarkers = fileIds.map((fileId) => getDriveImageMarker(fileId));
              const uploadQuestionTitle = questionTitleMap[questionId] || '';
              const slotFromTitle = getInstallmentSlotFromText(uploadQuestionTitle);
              const nextImageSlots = ensureFourSlots(base.proofOfPaymentImages);

              if (slotFromTitle) {
                nextImageSlots[slotFromTitle - 1] = imageMarkers[0];
                if (!base.paymentInstallment) {
                  base.paymentInstallment = `${slotFromTitle}${slotFromTitle === 1 ? 'st' : slotFromTitle === 2 ? 'nd' : slotFromTitle === 3 ? 'rd' : 'th'} Payment`;
                }
              } else {
                const firstAvailableSlot = nextImageSlots.findIndex((entry) => !entry);
                if (firstAvailableSlot >= 0) {
                  nextImageSlots[firstAvailableSlot] = imageMarkers[0];
                }
              }

              base.proofOfPaymentImages = nextImageSlots;

              // Keep backward-compatible single-image field as first available.
              if (!base.proofOfPaymentImage) {
                base.proofOfPaymentImage = imageMarkers[0];
                base.proofOfPayment = 'Form Upload';
              }
            }

            continue;
          }

          const fieldName = map[questionId];
          if (!fieldName) continue;

          // ── Normal text answer ───────────────────────────────────────────────
          const textValue = answer.textAnswers?.answers?.[0]?.value || '';

          if (fieldName === 'amountPaid' || fieldName === 'trainingFee') {
            base[fieldName] = parseFloat(textValue.replace(/[^0-9.]/g, '')) || 0;
          } else {
            base[fieldName] = textValue;
          }
        }

        if (Array.isArray(base.proofOfPaymentImages) && base.proofOfPaymentImages.length > 4) {
          base.proofOfPaymentImages = base.proofOfPaymentImages.slice(0, 4);
        }

        return base;
      });

      return { formTitle, formRawItems, formRecords, responseCount: allResponses.length };
    })
  );

  for (let i = 0; i < formResults.length; i++) {
    const result = formResults[i];
    if (result.status === 'fulfilled') {
      const { formTitle, formRawItems, formRecords, responseCount } = result.value;
      formTitles.push(formTitle);
      rawItems.push(...formRawItems);
      records.push(...formRecords);
      totalResponses += responseCount;
    } else {
      formErrors.push({
        formId: formIds[i],
        message: result.reason?.message || 'Failed to fetch form',
      });
    }
  }

  if (records.length === 0 && formErrors.length > 0) {
    const detail = formErrors.map((entry) => `${entry.formId}: ${entry.message}`).join(' | ');
    throw new Error(`Could not fetch responses from configured forms. ${detail}`);
  }

  const result = {
    formTitle: formTitles.length === 1 ? formTitles[0] : `${formTitles.length} forms`,
    totalResponses,
    records,
    rawItems,
    formIds,
    formTitles,
    formErrors,
  };

  if (DEFAULT_CACHE_TTL_MS > 0) {
    formResponseCache.set(cacheKey, {
      value: result,
      expiresAt: Date.now() + DEFAULT_CACHE_TTL_MS,
    });
  }

  return cloneFetchResult(result);
}

module.exports = { fetchFormResponses };
