# ATSOCA Payment Tracking Backend

A Node.js/Express server for managing payment records with MongoDB database.

## Setup Instructions

### Prerequisites
- Node.js installed
- MongoDB installed and running locally (or MongoDB Atlas connection string)

### Installation

1. Navigate to the backend directory:
```bash
cd backend
```

2. Install dependencies:
```bash
npm install
```

3. Configure MongoDB connection in `.env`:
```
MONGODB_URI=mongodb://localhost:27017/atsoca
PORT=5000
NODE_ENV=development
```

For MongoDB Atlas, use:
```
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/atsoca
```

4. Start the server:
```bash
npm start
```

For development with auto-reload:
```bash
npm run dev
```

The server will run on `http://localhost:5000`

## API Endpoints

### Auth (Forgot Password OTP)

- `POST /api/auth/forgot-password/request-otp`
  - Body: `{ "email": "user@gmail.com" }`
  - Sends a 6-digit OTP to the account email if the account is approved.

- `POST /api/auth/forgot-password/reset-with-otp`
  - Body: `{ "email": "user@gmail.com", "otp": "123456", "newPassword": "StrongPass1" }`
  - Resets password when OTP is valid and not expired.

### Get all payment records
`GET /api/payments`

### Get a single payment record
`GET /api/payments/:id`

### Create a new payment record
`POST /api/payments`
```json
{
  "email": "user@example.com",
  "completeName": "John Doe",
  "amountPaid": 50000,
  "paymentRecord": "Pending",
  "concerns": "None",
  "referenceNumber": "REF001",
  "proofOfPayment": "proof.pdf",
  "proofOfPaymentImage": "base64_encoded_image"
}
```

### Update a payment record
`PUT /api/payments/:id`

### Delete a payment record
`DELETE /api/payments/:id`

### Google Form import/sync
- `GET /api/form-sync/preview` - Preview Google Form responses without saving
- `POST /api/form-sync/sync` - Import responses into payment records
- `GET /api/form-sync/health` - Check Google Forms API connectivity

When importing from multiple forms, follow-up payments are merged into an existing payment record when the email address matches (case-insensitive). The imported amount is added to the existing `amountPaid`.

## Database

- **Database Name**: atsoca
- **Collections**: paymentrecords

## Environment Variables

- `MONGODB_URI`: MongoDB connection string
- `PORT`: Server port (default: 5000)
- `NODE_ENV`: Environment (development/production)
- `CLIENT_BASE_URL`: Frontend URL used for email links (default: http://localhost:5173)
- `ADMIN_USERNAME`: Bootstrap admin username (default: admin)
- `ADMIN_PASSWORD`: Bootstrap admin password (default: @soca_spark)
- `GOOGLE_SERVICE_ACCOUNT_KEY`: JSON credentials for Google service account
- `GOOGLE_FORM_ID`: Single Google Form ID (optional if using `GOOGLE_FORM_IDS`)
- `GOOGLE_FORM_IDS`: Comma-separated Google Form IDs for importing multiple forms

### Default Admin User

On backend startup, the server ensures a default admin account exists and is approved:

```env
ADMIN_USERNAME=admin
ADMIN_PASSWORD=@soca_spark
```

If the admin user already exists, role/approval are enforced and password is updated to match `ADMIN_PASSWORD`.

### Email Verification Delivery

By default, email sending can run in console simulation mode.

For a free provider option, use Resend (free tier) in `backend/.env`:

```env
EMAIL_DELIVERY_MODE=resend
EMAIL_FROM=no-reply@yourdomain.com
RESEND_API_KEY=re_xxxxxxxxxxxxxxxxx
```

You can also use SMTP if preferred:

```env
EMAIL_DELIVERY_MODE=smtp
EMAIL_FROM=no-reply@yourdomain.com
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_REQUIRE_TLS=true
SMTP_USER=your_smtp_username
SMTP_PASS=your_smtp_password_or_app_password
```

If you keep `EMAIL_DELIVERY_MODE=console`, the server will only log email content and no inbox delivery will happen.
