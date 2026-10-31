import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../env';
import { createOtpEmailSender } from '../email';

const env = (overrides: Record<string, unknown> = {}) => ({
  SMTP_HOST: 'smtp.invalid',
  SMTP_PORT: 587,
  SMTP_SECURE: 'false',
  SMTP_REQUIRE_TLS: 'true',
  SMTP_FROM: 'Seedkeep <no-reply@example.invalid>',
  ...overrides,
}) as unknown as Env;

describe('createOtpEmailSender', () => {
  it('sends an action-specific email with a clear five-minute expiry over required TLS', async () => {
    const sendMail = vi.fn(async () => undefined);
    const close = vi.fn();
    const createTransport = vi.fn(() => ({ sendMail, close }));
    const sendOtp = createOtpEmailSender(env(), createTransport);

    await sendOtp({ email: 'person@example.invalid', otp: '123456', type: 'sign-in' });

    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({
      host: 'smtp.invalid', port: 587, secure: false, requireTLS: true,
    }));
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'person@example.invalid',
      subject: 'Your Seedkeep sign-in code',
      text: expect.stringContaining('This code expires in 5 minutes.'),
      html: expect.stringContaining('This code expires in 5 minutes.'),
    }));
    expect(close).toHaveBeenCalledOnce();
  });

  it('fails closed without SMTP and never exposes provider diagnostics', async () => {
    const createTransport = vi.fn();
    await expect(createOtpEmailSender(env({ SMTP_HOST: undefined }), createTransport)(
      { email: 'person@example.invalid', otp: '123456', type: 'sign-in' },
    )).rejects.toThrow('Email delivery is not configured.');
    expect(createTransport).not.toHaveBeenCalled();

    const sendMail = vi.fn(async () => { throw new Error('provider detail'); });
    await expect(createOtpEmailSender(env(), () => ({ sendMail }))(
      { email: 'person@example.invalid', otp: '123456', type: 'sign-in' },
    )).rejects.toThrow('Email delivery failed.');
  });
});
