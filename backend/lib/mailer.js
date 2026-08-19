import nodemailer from 'nodemailer';

function getTransport() {
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT, 10),
    secure: false, // STARTTLS on 587 (Office365)
    auth: {
      user: process.env.SMTP_USERNAME,
      pass: process.env.SMTP_PASSWORD,
    },
  });
}

/**
 * Send an invite email to a new tenant.
 * @param {string} to        — recipient email
 * @param {string} orgName   — their brokerage name
 * @param {string} inviteUrl — full activate URL with token + email
 */
export async function sendInviteEmail(to, orgName, inviteUrl) {
  const fromName  = process.env.FROM_NAME  || 'Carrier Vetting';
  const fromEmail = process.env.FROM_EMAIL;
  const from      = `"${fromName}" <${fromEmail}>`;

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:sans-serif;max-width:560px;margin:40px auto;color:#111827;padding:0 16px;">
  <div style="background:#1e3a5f;padding:28px 32px;border-radius:8px 8px 0 0;">
    <h1 style="color:#fff;margin:0;font-size:20px;font-weight:800;">
      You're invited to Carrier Vetting
    </h1>
  </div>
  <div style="border:1px solid #e5e7eb;border-top:none;padding:28px 32px;border-radius:0 0 8px 8px;">
    <p style="margin:0 0 16px;font-size:15px;">Hi,</p>
    <p style="margin:0 0 16px;font-size:15px;">
      Your account for <strong>${orgName}</strong> has been created.
      Click the button below to set your password and get started.
    </p>
    <div style="text-align:center;margin:32px 0;">
      <a href="${inviteUrl}"
         style="background:#1e3a5f;color:#fff;padding:13px 32px;border-radius:7px;
                text-decoration:none;font-weight:700;font-size:15px;display:inline-block;">
        Create My Account
      </a>
    </div>
    <p style="margin:0 0 8px;font-size:13px;color:#6b7280;">
      This link expires in 72 hours. If you weren't expecting this, you can ignore it.
    </p>
    <p style="margin:16px 0 0;font-size:11px;color:#9ca3af;word-break:break-all;">
      Or copy this link into your browser:<br>${inviteUrl}
    </p>
  </div>
</body>
</html>`;

  await getTransport().sendMail({
    from,
    to,
    subject: `You're invited to ${fromName}`,
    html,
  });
}
