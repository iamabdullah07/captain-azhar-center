import type { Env } from '../types';

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * Sends transactional email via Resend (default) or Brevo using Worker secrets.
 * Never logs secrets or sensitive tokens.
 */
export async function sendEmail(env: Env, message: EmailMessage, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const apiKey = env.EMAIL_API_KEY;
  if (!apiKey) {
    console.warn('EMAIL_API_KEY is not configured; skipping email dispatch.');
    return false;
  }

  const provider = (env.EMAIL_PROVIDER ?? 'resend').toLowerCase();
  const from = env.EMAIL_FROM ?? 'Captain Azhar Center <onboarding@resend.dev>';

  try {
    if (provider === 'brevo') {
      // Parse "Name <email@domain>" if provided
      const match = from.match(/^(.*)<([^>]+)>$/);
      const senderName = match ? match[1].trim() : 'Captain Azhar Center';
      const senderEmail = match ? match[2].trim() : from.trim();

      const res = await fetchImpl('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sender: { name: senderName, email: senderEmail },
          to: [{ email: message.to }],
          subject: message.subject,
          htmlContent: message.html,
          textContent: message.text,
        }),
      });
      return res.ok;
    }

    // Default: Resend API
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
      }),
    });

    return res.ok;
  } catch (err) {
    console.warn('Email dispatch failed:', err instanceof Error ? err.message : 'unknown error');
    return false;
  }
}

export function buildPasswordResetEmail(resetUrl: string, appName = 'Captain Azhar Center'): {
  subject: string;
  html: string;
  text: string;
} {
  return {
    subject: `${appName} — Admin Password Reset`,
    text: `You requested a password reset for the ${appName} admin panel.\n\nOpen this one-time link within 30 minutes:\n${resetUrl}\n\nIf you did not request this, you can safely ignore this email.`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; color: #0A1832;">
        <h2 style="margin: 0 0 12px; color: #0A1832;">${appName} — Password Reset</h2>
        <p style="margin: 0 0 16px; color: #334155;">A password reset was requested for your admin account. This link works once and expires in <strong>30 minutes</strong>.</p>
        <p style="margin: 24px 0;">
          <a href="${resetUrl}" style="background:#0A1832;color:#D9A441;padding:12px 20px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;">Reset Admin Password</a>
        </p>
        <p style="font-size: 12px; color: #64748B;">If the button doesn't work, copy this URL:<br>${resetUrl}</p>
      </div>
    `,
  };
}

export function buildStorageAlertEmail(params: {
  usedBytes: number;
  limitBytes: number;
  triggerPct: number;
  appName?: string;
}): { subject: string; html: string; text: string } {
  const appName = params.appName ?? 'Captain Azhar Center';
  const usedGb = (params.usedBytes / (1024 ** 3)).toFixed(2);
  const limitGb = (params.limitBytes / (1024 ** 3)).toFixed(1);
  const pct = ((params.usedBytes / params.limitBytes) * 100).toFixed(1);

  return {
    subject: `${appName} — Storage Usage at ${pct}% (${usedGb} GB / ${limitGb} GB)`,
    text: `${appName} R2 storage usage has reached ${usedGb} GB (${pct}% of ${limitGb} GB).\n\nOldest uploaded files will begin auto-cleaning automatically once usage passes ${params.triggerPct}%.`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; color: #0A1832;">
        <h2 style="margin: 0 0 12px; color: #0A1832;">${appName} — Storage Warning (${pct}%)</h2>
        <p style="margin: 0 0 12px; color: #334155;">Your Cloudflare R2 bucket usage is currently <strong>${usedGb} GB / ${limitGb} GB</strong>.</p>
        <p style="margin: 0; color: #334155;">Auto-cleanup deletes oldest files first once usage crosses <strong>${params.triggerPct}%</strong>. Download any important older files before cleanup runs.</p>
      </div>
    `,
  };
}
