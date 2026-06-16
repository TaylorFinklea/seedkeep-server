/**
 * Security fix [BLOCKER 2] — Sprout history windowing real integration test.
 *
 * Replaces the tautology unit test in src/__tests__/historyWindowing.test.ts
 * which never ran the real SQL (it used rows.slice(-40) in memory against the
 * correct behavior, so it passed whether the DB query was right or wrong).
 *
 * This test:
 *   (a) Seeds a thread with 45 messages in real Postgres.
 *   (b) Calls the REAL loadConversationHistory function.
 *   (c) Asserts exactly 40 messages returned.
 *   (d) Asserts oldest-first ordering (msg 5 first, msg 44 last).
 *   (e) Asserts the 5 oldest messages (msg 0–4) are NOT present.
 *   (f) Asserts the newest message (msg 44) IS present.
 *   (g) Asserts a non-last image block in msg 5 is stripped to '[image omitted]'.
 *   (h) Asserts the image block in msg 44 (the last message) is NOT stripped.
 *
 * This test MUST fail against the old "ORDER BY created_at ASC, id ASC LIMIT 40"
 * query (which would return the OLDEST 40, missing msg 44).
 *
 * Run with:
 *   bun test tests/integration/historyWindowing.test.ts
 *
 * Prerequisites:
 *   - Local Postgres reachable at DATABASE_URL
 *   - Migrations applied (`bun run migrate`)
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import postgres, { type Sql } from 'postgres';
import { nanoid } from 'nanoid';
import { loadConversationHistory } from '../../src/routes/assistant';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://seedkeep:dev-only@localhost:5432/seedkeep';

const sql: Sql = postgres(DATABASE_URL, {
  transform: { undefined: null },
  onnotice: () => { /* silence */ },
  types: {
    bigint: {
      to: 20,
      from: [20],
      serialize: (x: number | bigint) => String(x),
      parse: (x: string) => Number(x),
    },
  },
});

const cleanup = {
  userIds: new Set<string>(),
  householdIds: new Set<string>(),
  threadIds: new Set<string>(),
};

function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 12)}`;
}

async function seedFixture(): Promise<{ threadId: string }> {
  const userId = uid('hw-user');
  const householdId = uid('hw-hh');
  const threadId = uid('hw-thr');
  const now = Date.now();

  await sql.unsafe(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     VALUES ($1, 'HW User', $2, TRUE,
             to_timestamp($3 / 1000.0), to_timestamp($3 / 1000.0))`,
    [userId, `${userId}@example.invalid`, now],
  );
  cleanup.userIds.add(userId);

  await sql.unsafe(
    `INSERT INTO households (id, name, created_at, updated_at)
     VALUES ($1, 'HW Household', $2, $2)`,
    [householdId, now],
  );
  cleanup.householdIds.add(householdId);

  await sql.unsafe(
    `INSERT INTO memberships (household_id, user_id, role, joined_at)
     VALUES ($1, $2, 'owner', $3)`,
    [householdId, userId, now],
  );

  await sql.unsafe(
    `INSERT INTO assistant_threads (id, household_id, title, thread_kind, created_at, updated_at)
     VALUES ($1, $2, 'HW Test Thread', 'chat', $3, $3)`,
    [threadId, householdId, now],
  );
  cleanup.threadIds.add(threadId);

  // Seed 45 messages: msg 0 to msg 44.
  // msg 5: user message with image (non-last — should be stripped).
  // msg 44: user message with image (last — must NOT be stripped).
  // All other messages: plain text.
  for (let i = 0; i < 45; i++) {
    const msgId = `hw-msg-${String(i).padStart(3, '0')}-${nanoid(6)}`;
    const role = i % 2 === 0 ? 'user' : 'assistant';
    // created_at: spread messages 1 second apart so ORDER BY is deterministic.
    const createdAt = now + i * 1000;

    let contentJson: string;
    if (i === 5) {
      // Non-last image: should be stripped to '[image omitted]' in history.
      contentJson = JSON.stringify([
        { type: 'text', text: `msg ${i}` },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'aaa' } },
      ]);
    } else if (i === 44) {
      // Last message with image: must NOT be stripped.
      contentJson = JSON.stringify([
        { type: 'text', text: `msg ${i}` },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'zzz' } },
      ]);
    } else {
      contentJson = JSON.stringify([{ type: 'text', text: `msg ${i}` }]);
    }

    await sql.unsafe(
      `INSERT INTO assistant_messages (id, thread_id, role, content_json, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [msgId, threadId, role, contentJson, createdAt],
    );
  }

  return { threadId };
}

beforeAll(async () => {
  await sql`SELECT 1`;
});

afterAll(async () => {
  for (const id of cleanup.threadIds) {
    // CASCADE deletes assistant_messages.
    await sql.unsafe(`DELETE FROM assistant_threads WHERE id = $1`, [id]).catch(() => {});
  }
  for (const id of cleanup.householdIds) {
    await sql.unsafe(`DELETE FROM households WHERE id = $1`, [id]).catch(() => {});
  }
  for (const id of cleanup.userIds) {
    await sql.unsafe(`DELETE FROM "user" WHERE id = $1`, [id]).catch(() => {});
  }
  await sql.end({ timeout: 5 });
});

describe('loadConversationHistory — real SQL windowing [BLOCKER 2]', () => {
  it('returns exactly 40 messages from a 45-message thread', async () => {
    const { threadId } = await seedFixture();
    const messages = await loadConversationHistory(sql, threadId);

    // (a) Exactly 40 returned.
    expect(messages).toHaveLength(40);
  });

  it('returns newest 40, oldest-first: msg 5 is first, msg 44 is last', async () => {
    // Re-use the thread seeded in the previous test within the same fixture run.
    // Use a fresh fixture to keep tests independent.
    const { threadId } = await seedFixture();
    const messages = await loadConversationHistory(sql, threadId);

    // (b) Oldest-first ordering: the first message returned should be msg 5
    //     (the 6th message overall, index 5 in the seed — oldest of the newest 40).
    const firstText = (messages[0].content[0] as { type: string; text?: string }).text;
    expect(firstText).toBe('msg 5');

    // (c) The 5 oldest (msg 0–4) must NOT appear.
    for (const msg of messages) {
      for (const block of msg.content) {
        const blk = block as { type: string; text?: string };
        if (blk.type === 'text' && blk.text) {
          expect(['msg 0', 'msg 1', 'msg 2', 'msg 3', 'msg 4']).not.toContain(blk.text);
        }
      }
    }

    // (d) The newest message (msg 44) must be present and last.
    const lastText = (messages[39].content[0] as { type: string; text?: string }).text;
    expect(lastText).toBe('msg 44');
  });

  it('strips image in non-last message but preserves image in last message', async () => {
    const { threadId } = await seedFixture();
    const messages = await loadConversationHistory(sql, threadId);

    // msg 5 maps to messages[0] (the oldest in the 40-window).
    // Its image block (index 1 in its content) must be replaced with '[image omitted]'.
    const msg5Content = messages[0].content as Array<{ type: string; text?: string }>;
    expect(msg5Content[0].type).toBe('text');
    expect(msg5Content[0].text).toBe('msg 5');
    // Second block: image must have been stripped.
    expect(msg5Content[1].type).toBe('text');
    expect(msg5Content[1].text).toBe('[image omitted]');

    // msg 44 is messages[39] (the last in the 40-window).
    // Its image block must NOT be stripped.
    const msg44Content = messages[39].content as Array<{ type: string }>;
    expect(msg44Content[0].type).toBe('text');
    expect(msg44Content[1].type).toBe('image');
  });
});
