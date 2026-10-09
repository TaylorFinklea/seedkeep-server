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
  send(message: MailMessage): Promise<void>;
}

/**
 * Mailer for this environment, or null when mail is not configured
 * (sign-in-code endpoints then return 503 mail_not_configured).
 * - 'resend' requires RESEND_API_KEY.
 * - 'log' is refused when APP_ENV is production or staging.
 * - Default when MAIL_PROVIDER is unset: 'log' in development, otherwise null.
 */
export function getMailer(env: Env): Mailer | null {
  void env;
  return null;
}

/** Test helper: messages captured by the 'memory' provider, newest last. */
export function sentMail(): readonly MailMessage[] {
  return [];
}

/** Test helper: clear captured messages. */
export function clearSentMail(): void {}
