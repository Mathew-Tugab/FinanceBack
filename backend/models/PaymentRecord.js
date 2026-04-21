const mongoose = require('mongoose');

const paymentRecordSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
    },
    completeName: {
      type: String,
      required: true,
    },
    enrollProgram: {
      type: String,
      default: '',
    },
    paymentInstallment: {
      type: String,
      default: '',
    },
    trainingFee: {
      type: Number,
      default: 0,
    },
    amountPaid: {
      type: Number,
      required: true,
    },
    paymentRecord: {
      type: String,
      enum: ['Pending', 'Completed'],
      default: 'Pending',
    },
    concerns: {
      type: String,
      default: 'None',
    },
    referenceNumber: {
      type: String,
      required: true,
    },
    referenceNumbers: {
      type: [String],
      default: [],
    },
    amountsPaid: {
      type: [Number],
      default: [],
    },
    referenceLabel: {
      type: String,
      enum: ['Auto', 'None', 'Group Payment', 'Repeated Reference Number'],
      default: 'Auto',
    },
    proofOfPaymentImages: {
      type: [String],
      default: [],
    },
    highlightImageSlot: {
      type: Number,
      min: 1,
      max: 4,
      default: 1,
    },
    followUpPayments: {
      type: [
        {
          slot: {
            type: Number,
            min: 1,
            max: 4,
            required: true,
          },
          paymentInstallment: {
            type: String,
            default: '',
          },
          referenceNumber: {
            type: String,
            default: '',
          },
          amountPaid: {
            type: Number,
            default: 0,
          },
          proofOfPaymentImage: {
            type: String,
            default: '',
          },
          formResponseId: {
            type: String,
            default: '',
          },
          submittedAt: {
            type: Date,
            default: Date.now,
          },
        },
      ],
      default: [],
    },
    formResponseId: {
      type: String,
      default: null,
      unique: true,
      sparse: true,
    },
    formResponseIds: {
      type: [String],
      default: [],
    },
    formSource: {
      type: String,
      default: '',
    },
    proofOfPayment: {
      type: String,
      required: true,
    },
    proofOfPaymentImage: {
      type: String,
      default: '',
    },
    archived: {
      type: Boolean,
      default: false,
    },
    receiptVerifiedSlots: {
      type: [
        {
          slot: { type: Number, required: true },
          verifiedAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('PaymentRecord', paymentRecordSchema);
