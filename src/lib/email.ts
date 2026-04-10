import { Resend } from 'resend';

const resend = new Resend(import.meta.env.RESEND_API_KEY);

const appName = import.meta.env.PUBLIC_APP_NAME || 'Flammard';

export async function sendAcknowledgementEmail({
  to,
  recipientName,
  meetingTitle,
  meetingDate,
  token,
  appUrl,
}: {
  to: string;
  recipientName?: string;
  meetingTitle: string;
  meetingDate: string;
  token: string;
  appUrl: string;
}) {
  const acknowledgeUrl = `${appUrl}/acknowledge/${token}`;
  const name = recipientName?.trim() || 'Attendee';
  const fromDomain = new URL(appUrl).hostname;

  const { error } = await resend.emails.send({
    from: `${appName} <no-reply@${fromDomain}>`,
    to,
    subject: `Meeting Minutes: ${meetingTitle} — ${meetingDate}`,
    html: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Meeting Minutes</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;background:#f4f4f6;padding:24px}
    .wrap{max-width:560px;margin:0 auto}
    .card{background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08),0 8px 24px rgba(0,0,0,.06)}
    .head{background:#08080c;padding:28px 32px}
    .head-label{color:#8a8b9a;font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;margin-bottom:6px}
    .head-title{color:#f0f0f5;font-size:20px;font-weight:600;line-height:1.3}
    .head-date{color:#8a8b9a;font-size:13px;margin-top:4px}
    .body{padding:28px 32px}
    p{color:#374151;font-size:15px;line-height:1.6;margin-bottom:16px}
    .btn{display:inline-block;background:#7b6cf6;color:#fff;text-decoration:none;padding:13px 26px;border-radius:8px;font-weight:600;font-size:15px;margin:4px 0 20px}
    .url-label{color:#9ca3af;font-size:12px;margin-bottom:4px}
    .url{word-break:break-all;color:#6b7280;font-size:12px;font-family:Consolas,monospace}
    .foot{background:#f9fafb;border-top:1px solid #e5e7eb;padding:18px 32px}
    .foot p{color:#9ca3af;font-size:12px;line-height:1.5;margin:0}
    .seal{display:inline-flex;align-items:center;gap:6px;background:#f3f4f6;border:1px solid #e5e7eb;border-radius:6px;padding:6px 10px;margin-top:12px}
    .seal-dot{width:6px;height:6px;background:#22c55e;border-radius:50%;flex-shrink:0}
    .seal-text{color:#6b7280;font-size:11px;font-family:Consolas,monospace}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="head">
        <div class="head-label">${appName} · Approved Minutes</div>
        <div class="head-title">${meetingTitle}</div>
        <div class="head-date">${meetingDate}</div>
      </div>
      <div class="body">
        <p>Hi ${name},</p>
        <p>The minutes from this meeting have been approved and sealed. Please review them and confirm receipt by clicking the button below.</p>
        <p><strong>No account or login is required</strong> — just click to confirm.</p>
        <a href="${acknowledgeUrl}" class="btn">View &amp; Acknowledge Minutes →</a>
        <p class="url-label">Or copy this link into your browser:</p>
        <p class="url">${acknowledgeUrl}</p>
      </div>
      <div class="foot">
        <p>You received this because you were listed as a meeting attendee. These minutes have been cryptographically sealed and cannot be altered after approval.</p>
        <div class="seal">
          <div class="seal-dot"></div>
          <span class="seal-text">Tamper-evident record · SHA-256 sealed</span>
        </div>
      </div>
    </div>
  </div>
</body>
</html>`,
  });

  if (error) throw new Error(`Resend error: ${JSON.stringify(error)}`);
}
