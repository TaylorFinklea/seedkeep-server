// Transactional mail for sign-in codes.
// CONTRACT STUB (web M1 Phase 2) — owner: Luna. Keep the exported API.
import type { Env } from '../../env';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface Mailer {
  /** Resolves when the provider accepted the message; rejects otherwise. */
  send(message: MailMessage, signal?: AbortSignal): Promise<void>;
}

const memoryMessages: MailMessage[] = [];

/**
 * Mailer for this environment, or null when mail is not configured
 * (sign-in-code endpoints then return 503 mail_not_configured).
 * - 'resend' requires RESEND_API_KEY.
 * - 'memory' is available only in development or test processes.
 * - 'log' is refused when APP_ENV is production or staging.
 * - Default when MAIL_PROVIDER is unset: 'log' in development, otherwise null.
 */
export function getMailer(env: Env): Mailer | null {
  const provider = env.MAIL_PROVIDER ?? (env.APP_ENV === 'development' ? 'log' : undefined);
  const from = env.MAIL_FROM?.trim() || 'Seedkeep <login@seedkeep.app>';
  if (provider === 'memory') {
    if (env.APP_ENV !== 'development' && process.env.NODE_ENV !== 'test') return null;
    return { async send(message) { memoryMessages.push({ ...message }); } };
  }
  if (provider === 'log') {
    if (env.APP_ENV === 'production' || env.APP_ENV === 'staging') return null;
    return { async send(message) {
      console.info(`[mail:dev] to=${message.to} subject=${message.subject} text=${message.text}`);
    } };
  }
  if (provider === 'resend') {
    const key = env.RESEND_API_KEY?.trim();
    if (!key) return null;
    return { async send(message, signal) {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [message.to], subject: message.subject, text: message.text, ...(message.html ? { html: message.html } : {}) }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5_000)]) : AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error(`Resend rejected email (${response.status})`);
    } };
  }
  return null;
}

/** Test helper: messages captured by the 'memory' provider, newest last. */
export function sentMail(): readonly MailMessage[] {
  return memoryMessages.map((message) => ({ ...message }));
}

/** Test helper: clear captured messages. */
export function clearSentMail(): void { memoryMessages.length = 0; }
