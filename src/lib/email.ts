import nodemailer from 'nodemailer';
import type { Env } from '../env';

export type OtpKind = 'sign-in' | 'email-verification' | 'forget-password' | 'change-email';

export interface OtpEmail {
  email: string;
  otp: string;
  type: OtpKind;
}

export interface MailTransport {
  sendMail(message: { from: string; to: string; subject: string; text: string; html: string }): Promise<unknown>;
  close?(): void;
}

export interface SmtpOptions {
  host: string;
  port: number;
  secure: boolean;
  requireTLS: boolean;
  connectionTimeout: number;
  greetingTimeout: number;
  socketTimeout: number;
  auth?: { user: string; pass: string };
}

export type TransportFactory = (options: SmtpOptions) => MailTransport;

const defaultTransportFactory: TransportFactory = (options) =>
  nodemailer.createTransport(options) as unknown as MailTransport;

export function createOtpEmailSender(
  env: Env,
  createTransport: TransportFactory = defaultTransportFactory,
): (email: OtpEmail) => Promise<void> {
  return async ({ email, otp, type }) => {
    if (!env.SMTP_HOST || !env.SMTP_FROM) {
      throw new Error('Email delivery is not configured.');
    }
    if (Boolean(env.SMTP_USER) !== Boolean(env.SMTP_PASSWORD)) {
      throw new Error('Email delivery is not configured.');
    }

    const subject =
      type === 'sign-in'
        ? 'Your Seedkeep sign-in code'
        : type === 'email-verification'
          ? 'Verify your Seedkeep email'
          : type === 'forget-password'
            ? 'Your Seedkeep account recovery code'
            : 'Confirm your Seedkeep email change';
    const action =
      type === 'sign-in'
        ? 'Use this code to sign in to Seedkeep.'
        : type === 'email-verification'
          ? 'Use this code to verify your email address.'
          : type === 'forget-password'
            ? 'Use this code to continue your account recovery.'
            : 'Use this code to confirm your email change.';
    const text = `${action}\n\n${otp}\n\nThis code expires in 5 minutes. If you did not request it, you can ignore this message.`;
    const html = `<!doctype html><html lang="en"><body style="margin:0;padding:24px;background:#f7f5ef;color:#24382b;font-family:Arial,sans-serif"><main style="max-width:480px;margin:0 auto;padding:28px;background:#fff;border:1px solid #ddd8cb;border-radius:12px"><h1 style="margin:0 0 20px;font-size:24px">Seedkeep</h1><p style="font-size:16px;line-height:1.5">${action}</p><p style="margin:24px 0;text-align:center;font-family:monospace;font-size:32px;letter-spacing:0.2em;font-weight:700">${otp}</p><p style="font-size:14px;line-height:1.5">This code expires in 5 minutes. If you did not request it, you can ignore this message.</p></main></body></html>`;

    let transport: MailTransport | undefined;
    try {
      transport = createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT ?? 587,
        secure: env.SMTP_SECURE === 'true',
        requireTLS: env.SMTP_REQUIRE_TLS !== 'false',
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 15_000,
        ...(env.SMTP_USER && env.SMTP_PASSWORD
          ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } }
          : {}),
      });
      await transport.sendMail({ from: env.SMTP_FROM, to: email, subject, text, html });
    } catch {
      // Never return provider diagnostics, addresses, or OTP values to callers or logs.
      throw new Error('Email delivery failed.');
    } finally {
      transport?.close?.();
    }
  };
}
