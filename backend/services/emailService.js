const nodemailer = require('nodemailer');
const { Resend } = require('resend');

const EMAIL_MODE_SMTP = 'smtp';
const EMAIL_MODE_RESEND = 'resend';
const EMAIL_MODE_CONSOLE = 'console';

let mailTransporter = null;
let resendClient = null;
let startupModeLogged = false;

function hasSmtpConfiguration() {
  return Boolean(
    process.env.SMTP_HOST
      && process.env.SMTP_PORT
      && process.env.SMTP_USER
      && process.env.SMTP_PASS
      && process.env.EMAIL_FROM
  );
}

function hasResendConfiguration() {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

function getEmailDeliveryMode() {
  const configuredMode = (process.env.EMAIL_DELIVERY_MODE || '').trim().toLowerCase();
  if (
    configuredMode === EMAIL_MODE_SMTP
    || configuredMode === EMAIL_MODE_RESEND
    || configuredMode === EMAIL_MODE_CONSOLE
  ) {
    return configuredMode;
  }

  if (hasResendConfiguration()) {
    return EMAIL_MODE_RESEND;
  }

  return hasSmtpConfiguration() ? EMAIL_MODE_SMTP : EMAIL_MODE_CONSOLE;
}

function toBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  return ['true', '1', 'yes', 'on'].includes(String(value).toLowerCase());
}

function logStartupMode(mode) {
  if (startupModeLogged) {
    return;
  }

  startupModeLogged = true;

  if (mode === EMAIL_MODE_SMTP) {
    console.log('Email delivery mode: SMTP');
    return;
  }

  if (mode === EMAIL_MODE_RESEND) {
    console.log('Email delivery mode: Resend API');
    return;
  }

  console.warn('Email delivery mode: console (no real email will be sent).');
}

function getResendClient() {
  if (resendClient) {
    return resendClient;
  }

  resendClient = new Resend(process.env.RESEND_API_KEY);
  return resendClient;
}

function getSmtpTransporter() {
  if (mailTransporter) {
    return mailTransporter;
  }

  const port = Number(process.env.SMTP_PORT);
  const secure = process.env.SMTP_SECURE !== undefined
    ? toBoolean(process.env.SMTP_SECURE)
    : port === 465;

  mailTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure,
    auth: {
      user: process.env.SMTP_USER,
      pass: String(process.env.SMTP_PASS || '').replace(/\s+/g, ''),
    },
    requireTLS: toBoolean(process.env.SMTP_REQUIRE_TLS),
  });

  return mailTransporter;
}

async function sendEmail({ to, subject, text, html }) {
  const mode = getEmailDeliveryMode();
  logStartupMode(mode);

  if (mode === EMAIL_MODE_CONSOLE) {
    console.log('--- EMAIL OUTBOUND (SIMULATED) ---');
    console.log('To:', to);
    console.log('Subject:', subject);
    console.log('Text:', text);
    if (html) {
      console.log('HTML length:', html.length);
    }
    console.log('----------------------------------');
    return;
  }

  if (mode === EMAIL_MODE_RESEND) {
    if (!hasResendConfiguration()) {
      throw new Error('Resend email delivery mode requires RESEND_API_KEY and EMAIL_FROM.');
    }

    const client = getResendClient();
    const { data, error } = await client.emails.send({
      from: process.env.EMAIL_FROM,
      to,
      subject,
      text,
      html,
    });

    if (error) {
      throw new Error(error.message || 'Failed to send email with Resend');
    }

    console.log('Email sent:', data?.id || 'resend-ok');
    return;
  }

  if (!hasSmtpConfiguration()) {
    throw new Error('SMTP email delivery mode requires SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, and EMAIL_FROM.');
  }

  const transporter = getSmtpTransporter();
  const info = await transporter.sendMail({
    from: process.env.EMAIL_FROM,
    to,
    subject,
    text,
    html,
  });

  console.log('Email sent:', info.messageId);
}

async function sendEmailWithSmtp({ to, subject, text, html }) {
  if (!hasSmtpConfiguration()) {
    throw new Error('OTP delivery requires SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, and EMAIL_FROM.');
  }

  const transporter = getSmtpTransporter();
  const info = await transporter.sendMail({
    from: process.env.EMAIL_FROM,
    to,
    subject,
    text,
    html,
  });

  console.log('OTP email sent via Nodemailer:', info.messageId);
}

function buildOtpEmailHtml({ otpCode, heading, subheading, footer }) {
  const digits = String(otpCode).split('');
  const digitCells = digits
    .map(
      (d) =>
        `<td align="center" style="padding:0 5px;">
          <div style="width:44px;height:52px;line-height:52px;border-radius:10px;background:#ffffff;border:2px solid #dbeafa;font-size:22px;font-weight:700;color:#355872;text-align:center;">${d}</div>
        </td>`
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/></head>
<body style="margin:0;padding:0;background-color:#f8fcff;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fcff;padding:40px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="460" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:20px;border:1px solid #dbeafa;box-shadow:0 2px 16px rgba(53,88,114,0.06);overflow:hidden;">
          <!-- Logo -->
          <tr>
            <td align="center" style="padding:36px 0 0;">
              <span style="font-size:14px;font-weight:800;letter-spacing:2px;color:#355872;">ATSOCA</span>
            </td>
          </tr>
          <!-- Envelope illustration -->
          <tr>
            <td align="center" style="padding:28px 0 8px;">
              <div style="width:120px;height:120px;border-radius:50%;background:linear-gradient(135deg,#eaf3fb 0%,#d2e7f9 100%);display:inline-block;text-align:center;line-height:120px;">
                <span style="font-size:54px;line-height:120px;">&#9993;</span>
              </div>
            </td>
          </tr>
          <!-- Heading -->
          <tr>
            <td align="center" style="padding:20px 32px 6px;">
              <h1 style="margin:0;font-size:22px;font-weight:700;color:#1e1e2d;">${heading}</h1>
            </td>
          </tr>
          <!-- Subheading -->
          <tr>
            <td align="center" style="padding:0 40px 28px;">
              <p style="margin:0;font-size:14px;color:#8b8b9e;line-height:1.5;">${subheading}</p>
            </td>
          </tr>
          <!-- OTP digits -->
          <tr>
            <td align="center" style="padding:0 32px 32px;">
              <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;">
                <tr>${digitCells}</tr>
              </table>
            </td>
          </tr>
          <!-- Footer note -->
          <tr>
            <td align="center" style="padding:0 40px 36px;">
              <p style="margin:0;font-size:12px;color:#b0b0c0;line-height:1.6;">${footer}</p>
            </td>
          </tr>
          <!-- Bottom bar -->
          <tr>
            <td style="height:6px;background:linear-gradient(90deg,#355872 0%,#5a8fb4 50%,#d2e7f9 100%);border-radius:0 0 20px 20px;"></td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

async function sendVerificationEmail(email, verificationUrl) {
  return sendEmail({
    to: email,
    subject: 'Verify your account',
    text: `Verify your account by clicking this link: ${verificationUrl}`,
  });
}

async function sendPasswordResetEmail(email, resetUrl) {
  return sendEmail({
    to: email,
    subject: 'Password reset request',
    text: `Reset your password using this link (expires soon): ${resetUrl}`,
  });
}

async function sendLoginOtpEmail(email, otpCode, expiresAt) {
  const expiryText = new Date(expiresAt).toLocaleString();

  return sendEmailWithSmtp({
    to: email,
    subject: 'Your ATSOCA login OTP',
    text: `Your one-time password is ${otpCode}. It expires at ${expiryText}.`,
    html: buildOtpEmailHtml({
      otpCode,
      heading: 'Here is your One Time Password',
      subheading: 'for logging in to ATSOCA',
      footer: `This code expires at ${expiryText}. If you did not request this, you can safely ignore this email.`,
    }),
  });
}

async function sendForgotPasswordOtpEmail(email, otpCode, expiresAt) {
  const expiryText = new Date(expiresAt).toLocaleString();

  return sendEmailWithSmtp({
    to: email,
    subject: 'Your ATSOCA password reset OTP',
    text: `Your password reset OTP is ${otpCode}. It expires at ${expiryText}. If you did not request this, you can ignore this email.`,
    html: buildOtpEmailHtml({
      otpCode,
      heading: 'Password Reset Code',
      subheading: 'Use this code to reset your ATSOCA password',
      footer: `This code expires at ${expiryText}. If you did not request a password reset, you can safely ignore this email.`,
    }),
  });
}

async function sendEmailVerificationOtp(email, otpCode, expiresAt) {
  const expiryText = new Date(expiresAt).toLocaleString();

  return sendEmail({
    to: email,
    subject: 'Verify your ATSOCA account',
    text: `Your email verification code is ${otpCode}. It expires at ${expiryText}.\n\nIf you did not register for ATSOCA, you can ignore this message.`,
    html: buildOtpEmailHtml({
      otpCode,
      heading: 'Verify Your Account',
      subheading: 'Use this code to verify your ATSOCA email',
      footer: `This code expires at ${expiryText}. If you did not register for ATSOCA, you can safely ignore this email.`,
    }),
  });
}

async function sendPaymentVerifiedEmail(email, { completeName, amountPaid, referenceNumber, enrollProgram }) {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase();
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  const formattedAmount = `PHP ${Number(amountPaid).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const programRow = enrollProgram
    ? `<tr>
        <td style="padding:6px 0;font-size:11px;letter-spacing:1px;color:#8b8b9e;text-transform:uppercase;">Program</td>
      </tr>
      <tr>
        <td style="padding:0 0 18px;font-size:16px;font-weight:600;color:#1e1e2d;">${enrollProgram}</td>
      </tr>`
    : '';

  const html = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/></head>
<body style="margin:0;padding:0;background-color:#f4f4f8;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f8;padding:40px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="420" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;box-shadow:0 2px 12px rgba(0,0,0,0.06);overflow:hidden;">
          <!-- Icon -->
          <tr>
            <td align="center" style="padding:40px 0 16px;">
              <span style="font-size:56px;line-height:1;">&#127881;</span>
            </td>
          </tr>
          <!-- Heading -->
          <tr>
            <td align="center" style="padding:0 32px 8px;">
              <h1 style="margin:0;font-size:26px;font-weight:700;color:#1e1e2d;">Thank you</h1>
            </td>
          </tr>
          <!-- Subtitle -->
          <tr>
            <td align="center" style="padding:0 40px 32px;">
              <p style="margin:0;font-size:14px;color:#8b8b9e;line-height:1.5;">Your payment has been processed<br/>successfully.</p>
            </td>
          </tr>
          <!-- Dashed divider -->
          <tr>
            <td style="padding:0 32px;">
              <div style="border-top:2px dashed #d8d8e5;"></div>
            </td>
          </tr>
          <!-- Details -->
          <tr>
            <td style="padding:24px 32px 0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:6px 0;font-size:11px;letter-spacing:1px;color:#8b8b9e;text-transform:uppercase;" width="50%">Reference No.</td>
                  <td style="padding:6px 0;font-size:11px;letter-spacing:1px;color:#8b8b9e;text-transform:uppercase;" align="right">Amount</td>
                </tr>
                <tr>
                  <td style="padding:0 0 18px;font-size:16px;font-weight:600;color:#1e1e2d;">${referenceNumber}</td>
                  <td style="padding:0 0 18px;font-size:16px;font-weight:600;color:#1e1e2d;" align="right">${formattedAmount}</td>
                </tr>
                <tr>
                  <td colspan="2" style="padding:6px 0;font-size:11px;letter-spacing:1px;color:#8b8b9e;text-transform:uppercase;">Date &amp; Time</td>
                </tr>
                <tr>
                  <td colspan="2" style="padding:0 0 18px;font-size:16px;font-weight:600;color:#1e1e2d;">${dateStr} | ${timeStr}</td>
                </tr>
                ${programRow}
              </table>
            </td>
          </tr>
          <!-- Recipient card -->
          <tr>
            <td style="padding:8px 32px 32px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f8;border-radius:12px;">
                <tr>
                  <td style="padding:16px 20px;">
                    <span style="font-size:14px;font-weight:600;color:#1e1e2d;">${completeName}</span><br/>
                    <span style="font-size:12px;color:#8b8b9e;">${email}</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td align="center" style="padding:0 32px 32px;">
              <p style="margin:0;font-size:12px;color:#b0b0c0;line-height:1.5;">No further action is needed on your part.<br/>&copy; ATSOCA Team</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return sendEmail({
    to: email,
    subject: 'Your ATSOCA payment has been verified',
    text: `Hi ${completeName},\n\nYour payment of ${formattedAmount}${enrollProgram ? ` for ${enrollProgram}` : ''} (Ref: ${referenceNumber}) has been verified on ${dateStr} at ${timeStr}. No further action is needed.\n\nThank you,\nATSOCA Team`,
    html,
  });
}

module.exports = {
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendLoginOtpEmail,
  sendForgotPasswordOtpEmail,
  sendEmailVerificationOtp,
  sendPaymentVerifiedEmail,
};
