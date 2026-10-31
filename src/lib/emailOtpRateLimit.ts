import { createHmac, randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';

const RATE_PREFIX = 'seedkeep-email-otp-rate:';
const GLOBAL_IDENTIFIER = `${RATE_PREFIX}global`;
const WINDOW_MS = 60_000;
const PER_EMAIL_LIMIT = 3;
const GLOBAL_LIMIT = 60;

/**
 * Reserve one browser OTP-send attempt. Counters use the existing verification
 * table and contain only a keyed hash of the normalized address. The global
 * budget also applies when the request body is malformed or has no email.
 */
export async function reserveEmailOtpSend(
  sql: Sql,
  secret: string,
  email: string | undefined,
): Promise<{ limited: boolean; scope: 'email' | 'global' | null }> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + WINDOW_MS);
  const identifiers: { identifier: string; limit: number; scope: 'email' | 'global' }[] = [
    { identifier: GLOBAL_IDENTIFIER, limit: GLOBAL_LIMIT, scope: 'global' },
  ];
  if (email) {
    const normalizedEmail = email.trim().toLowerCase();
    const digest = createHmac('sha256', secret).update(normalizedEmail).digest('hex');
    identifiers.push({ identifier: `${RATE_PREFIX}email:${digest}`, limit: PER_EMAIL_LIMIT, scope: 'email' as const });
  }
  identifiers.sort((a, b) => a.identifier.localeCompare(b.identifier));

  return sql.begin(async (tx) => {
    for (const item of identifiers) {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${item.identifier}, 0))`;
    }
    // Keep only live buckets. This exact prefix is reserved by this limiter;
    // normal Better Auth verification rows are unaffected.
    await tx`DELETE FROM verification
              WHERE identifier LIKE ${`${RATE_PREFIX}%`}
                AND "expiresAt" <= ${now}`;

    const current = new Map<string, { id: string; count: number }>();
    for (const item of identifiers) {
      const rows = await tx<{ id: string; value: string }[]>`
        SELECT id, value FROM verification
         WHERE identifier = ${item.identifier} AND "expiresAt" > ${now}
         ORDER BY "createdAt" DESC LIMIT 1 FOR UPDATE
      `;
      if (rows[0]) {
        const count = /^\d+$/.test(rows[0].value) ? Number(rows[0].value) : Number.NaN;
        if (!Number.isSafeInteger(count) || count < 1) return { limited: true, scope: item.scope };
        if (count >= item.limit) return { limited: true, scope: item.scope };
        current.set(item.identifier, { id: rows[0].id, count });
      }
    }

    for (const item of identifiers) {
      const existing = current.get(item.identifier);
      if (existing) {
        await tx`UPDATE verification SET value = ${String(existing.count + 1)}, "updatedAt" = ${now}
                  WHERE id = ${existing.id}`;
      } else {
        await tx`INSERT INTO verification (id, identifier, value, "expiresAt", "createdAt", "updatedAt")
                 VALUES (${randomUUID()}, ${item.identifier}, '1', ${expiresAt}, ${now}, ${now})`;
      }
    }
    return { limited: false, scope: null };
  });
}
