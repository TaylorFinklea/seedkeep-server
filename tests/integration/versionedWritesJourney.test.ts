/** Phase 3 garden integrity journey: versions, replay, child change signals and cascades. */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import postgres, { type Sql } from 'postgres';
import { createApp } from '../../src/index';
import type { Env } from '../../src/env';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://seedkeep:dev-only@localhost:5432/seedkeep';
const sql: Sql = postgres(DATABASE_URL, {
  transform: { undefined: null }, onnotice: () => {},
  types: { bigint: { to: 20, from: [20], serialize: (x: number | bigint) => String(x), parse: (x: string) => Number(x) } },
});
const TEST_ENV: Env = {
  PORT: 8787, APP_ENV: 'development', DATABASE_URL,
  S3_REGION: 'us-east-1', S3_ACCESS_KEY_ID: 'test-access-key', S3_SECRET_ACCESS_KEY: 'test-secret-key', S3_BUCKET: 'test-bucket', S3_FORCE_PATH_STYLE: false,
  BETTER_AUTH_SECRET: 'test-better-auth-secret-1234567890', APPLE_CLIENT_ID: 'test-apple-client', APPLE_CLIENT_SECRET: 'test-apple-secret',
  ANTHROPIC_API_KEY: undefined, APPLE_IAP_SHARED_SECRET: undefined, ASSISTANT_KEY_MASTER: undefined,
  DEFAULT_VISION_MODEL: 'claude-sonnet-4-6', DEFAULT_REVIEW_MODEL: 'claude-haiku-4-5-20251001', ADMIN_SECRET: undefined, GARDEN_TOOLS_ENABLED: true,
};
const app = createApp(TEST_ENV);
const cleanup = { households: new Set<string>(), users: new Set<string>() };
const uid = (p: string) => `${p}-${crypto.randomUUID()}`;
interface Fixture { householdId: string; userId: string; token: string }

async function fixture(): Promise<Fixture> {
  const userId = uid('vwi-user'); const householdId = uid('vwi-house');
  const sessionId = uid('vwi-session'); const token = uid('vwi-token'); const now = Date.now();
  await sql.unsafe(`INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'Test',$2,TRUE,$3,$3)`, [userId, `${userId}@example.invalid`, now]);
  await sql.unsafe(`INSERT INTO session (id,"expiresAt",token,"createdAt","updatedAt","ipAddress","userAgent","userId") VALUES ($1,NOW()+INTERVAL '1 day',$2,NOW(),NOW(),NULL,NULL,$3)`, [sessionId, token, userId]);
  await sql.unsafe(`INSERT INTO households (id,name,created_at,updated_at) VALUES ($1,'Journey',$2,$2)`, [householdId, now]);
  await sql.unsafe(`INSERT INTO memberships (household_id,user_id,role,joined_at) VALUES ($1,$2,'owner',$3)`, [householdId, userId, now]);
  cleanup.households.add(householdId); cleanup.users.add(userId);
  return { householdId, userId, token };
}
function request(fx: Fixture, path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  return app.request(`/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${fx.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, TEST_ENV);
}
async function json<T>(res: Response): Promise<T> { return await res.json() as T; }
async function makeSeed(fx: Fixture, id = uid('vwi-seed')) {
  const res = await request(fx, '/seeds', 'POST', { id, state: 'active', custom_type: 'Heritage' });
  expect(res.status).toBe(200);
  return id;
}
async function makeJournal(fx: Fixture, id: string, attach: Record<string, string> = {}) {
  const res = await request(fx, '/journal', 'POST', { id, occurred_on: '2026-06-15', body: 'first', ...attach });
  return res;
}

beforeAll(async () => { await sql`SELECT 1`; });
afterAll(async () => {
  for (const id of cleanup.households) await sql.unsafe(`DELETE FROM households WHERE id=$1`, [id]).catch(() => {});
  for (const id of cleanup.users) await sql.unsafe(`DELETE FROM "user" WHERE id=$1`, [id]).catch(() => {});
  await sql.end({ timeout: 5 });
});

describe('versioned garden writes', () => {
  it('PATCH is field-selective, honors If-Match and returns current state on conflict', async () => {
    const fx = await fixture(); const seedId = uid('vwi-seed');
    const created = await request(fx, '/seeds', 'POST', { id: seedId, state: 'active', packet_count: 5, source: 'gift' });
    expect(created.status).toBe(200);
    const first = await request(fx, `/seeds/${seedId}`, 'PATCH', { notes: 'updated' }, { 'If-Match': '"1"' });
    expect(first.status).toBe(200); expect(first.headers.get('ETag')).toBe('"2"');
    const firstJson = await json<{ data: { seed: { version: number; state: string; packet_count: number; source: string } } }>(first);
    expect(firstJson.data.seed).toMatchObject({ version: 2, state: 'active', packet_count: 5, source: 'gift' });
    const stale = await request(fx, `/seeds/${seedId}`, 'PATCH', { state: 'wishlist' }, { 'If-Match': '1' });
    expect(stale.status).toBe(409);
    expect((await json<{ data: { current: { version: number; notes: string } } }>(stale)).data.current).toMatchObject({ version: 2, notes: 'updated' });
    expect((await request(fx, `/seeds/${seedId}`, 'PATCH', { state: 'wishlist' }, { 'If-Match': 'W/"2"' })).status).toBe(400);
    expect((await request(fx, `/seeds/${seedId}`, 'PATCH', { custom_type: 'x'.repeat(81) })).status).toBe(400);
    const race = await Promise.all([
      request(fx, `/seeds/${seedId}`, 'PATCH', { notes: 'race-a' }, { 'If-Match': '2' }),
      request(fx, `/seeds/${seedId}`, 'PATCH', { state: 'saved' }, { 'If-Match': '2' }),
    ]);
    expect(race.map((r) => r.status).sort()).toEqual([200, 409]);
    const legacy = await request(fx, `/seeds/${seedId}`, 'PATCH', { notes: 'legacy write' });
    expect(legacy.status).toBe(200);
    const feed = await request(fx, '/seeds?since=0');
    const feedJson = await json<{ data: { items: Array<{ id: string; version: number; custom_type: string }> } }>(feed);
    expect(feedJson.data.items.find((item) => item.id === seedId)).toMatchObject({ version: 4, packet_count: 5 });
    const deleted = await request(fx, `/seeds/${seedId}`, 'DELETE', undefined, { 'If-Match': '4' });
    expect(deleted.status).toBe(200);
    const replay = await request(fx, '/seeds', 'POST', { id: seedId, state: 'active', custom_type: 'Heritage' });
    expect(replay.status).toBe(200);
    expect((await json<{ data: { seed: { deleted_at: number | null; version: number } } }>(replay)).data.seed).toMatchObject({ version: 5 });
  });

  it('journal and checklist client ids replay; child mutations bump the parent', async () => {
    const fx = await fixture(); const entryId = uid('vwi-entry');
    const first = await makeJournal(fx, entryId); expect(first.status).toBe(200);
    const replay = await makeJournal(fx, entryId); expect(replay.status).toBe(200);
    const journalPatch = await request(fx, `/journal/${entryId}`, 'PATCH', { body: 'updated' }, { 'If-Match': '"1"' });
    expect(journalPatch.status).toBe(200); expect(journalPatch.headers.get('ETag')).toBe('"2"');
    expect((await request(fx, `/journal/${entryId}`, 'PATCH', { body: 'bad' }, { 'If-Match': '1' })).status).toBe(409);
    expect((await request(fx, `/journal/${entryId}`, 'PATCH', { body: 'bad' }, { 'If-Match': 'W/"2"' })).status).toBe(400);
    expect((await makeJournal(fx, entryId)).status).toBe(200);
    const itemId = uid('vwi-item');
    const item = await request(fx, `/journal/${entryId}/checklist`, 'POST', { id: itemId, text: 'Water' });
    expect(item.status).toBe(200);
    expect((await json<{ data: { item: { version: number } } }>(item)).data.item.version).toBe(1);
    expect((await request(fx, `/journal/${entryId}/checklist`, 'POST', { id: itemId, text: 'ignored' })).status).toBe(200);
    const patch = await request(fx, `/journal/checklist/${itemId}`, 'PATCH', { completed: true }, { 'If-Match': '1' });
    expect(patch.status).toBe(200);
    expect((await json<{ data: { item: { version: number } } }>(patch)).data.item.version).toBe(2);
    const parent = await sql.unsafe<{ version: number }[]>(`SELECT version FROM journal_entries WHERE id=$1`, [entryId]);
    expect(parent[0]!.version).toBe(4);
    const itemReplay = await request(fx, `/journal/${entryId}/checklist`, 'POST', { id: itemId, text: 'ignored again' });
    expect((await json<{ data: { item: { version: number; text: string } } }>(itemReplay)).data.item).toMatchObject({ version: 2, text: 'Water' });
    const otherEntryId = uid('vwi-other-entry');
    expect((await makeJournal(fx, otherEntryId)).status).toBe(200);
    const wrongParentReplay = await request(fx, `/journal/${otherEntryId}/checklist`, 'POST', { id: itemId, text: 'Water again' });
    expect(wrongParentReplay.status).toBe(409);
    const checklistFeed = await request(fx, `/journal?since=0`);
    expect((await json<{ data: { items: Array<{ id: string; version: number }> } }>(checklistFeed)).data.items.find((item) => item.id === entryId)?.version).toBe(4);
  });

  it('photo client ids replay in-household and reference checks hide foreign rows', async () => {
    const a = await fixture(); const b = await fixture(); const seedId = await makeSeed(a);
    const foreignRef = await request(b, '/journal', 'POST', { id: uid('vwi-invalid-ref'), occurred_on: '2026-06-15', seed_id: seedId });
    expect(foreignRef.status).toBe(400);
    expect((await json<{ error: { code: string } }>(foreignRef)).error.code).toBe('invalid_reference');
    const clientEntryId = uid('vwi-shared-entry-id');
    expect((await makeJournal(a, clientEntryId)).status).toBe(200);
    const foreignReplay = await makeJournal(b, clientEntryId);
    expect(foreignReplay.status).toBe(409);
    expect((await json<{ error: { code: string } }>(foreignReplay)).error.code).toBe('conflict');

    const entryId = uid('vwi-photo-entry'); await makeJournal(a, entryId);
    const seedPhotoId = uid('vwi-seed-photo'); const journalPhotoId = uid('vwi-journal-photo'); const now = Date.now();
    const otherSeedId = await makeSeed(a);
    const otherEntryId = uid('vwi-other-photo-entry'); await makeJournal(a, otherEntryId);
    await sql.unsafe(`INSERT INTO seed_photos (id,seed_id,household_id,r2_key,role,captured_at) VALUES ($1,$2,$3,'seed-replay-key','extra',$4)`, [seedPhotoId, seedId, a.householdId, now]);
    await sql.unsafe(`INSERT INTO journal_entry_photos (id,entry_id,household_id,storage_key,sort_order,created_at,updated_at) VALUES ($1,$2,$3,'journal-replay-key',0,$4,$4)`, [journalPhotoId, entryId, a.householdId, now]);
    const seedReplay = await request(a, `/seeds/${seedId}/photos?id=${seedPhotoId}`, 'POST');
    expect(seedReplay.status).toBe(200);
    expect((await json<{ data: { photo: { id: string; r2_key: string } } }>(seedReplay)).data.photo).toMatchObject({ id: seedPhotoId, r2_key: 'seed-replay-key' });
    const journalReplay = await request(a, `/journal/${entryId}/photos?id=${journalPhotoId}`, 'POST');
    expect(journalReplay.status).toBe(200);
    expect((await json<{ data: { photo: { id: string; storageKey: string } } }>(journalReplay)).data.photo).toMatchObject({ id: journalPhotoId, storageKey: 'journal-replay-key' });
    expect((await request(a, `/seeds/${otherSeedId}/photos?id=${seedPhotoId}`, 'POST')).status).toBe(409);
    expect((await request(a, `/journal/${otherEntryId}/photos?id=${journalPhotoId}`, 'POST')).status).toBe(409);
    expect((await request(b, `/seeds/${seedId}/photos?id=${seedPhotoId}`, 'POST')).status).toBe(409);
  });

  it('event create replay returns the stored updated or deleted row without duplicate children', async () => {
    const fx = await fixture(); const eventId = uid('vwi-event');
    const post = () => request(fx, '/planting-events', 'POST', { id: eventId, kind: 'sowing', planned_for: '2026-06-15' });
    const first = await post(); expect(first.status).toBe(200);
    const again = await post(); expect(again.status).toBe(200);
    const children = await sql.unsafe<{ entries: number; items: number }[]>(`SELECT
      (SELECT count(*)::int FROM journal_entries WHERE planting_event_id=$1) AS entries,
      (SELECT count(*)::int FROM journal_checklist_items ci JOIN journal_entries je ON je.id=ci.entry_id WHERE je.planting_event_id=$1) AS items`, [eventId]);
    expect(children[0]).toEqual({ entries: 1, items: 1 });
    const patch = await request(fx, `/planting-events/${eventId}`, 'PATCH', { notes: 'changed' }, { 'If-Match': '1' });
    expect(patch.status).toBe(200);
    expect((await request(fx, `/planting-events/${eventId}`, 'PATCH', { notes: 'stale' }, { 'If-Match': '1' })).status).toBe(409);
    expect((await json<{ data: { planting_event: { version: number } } }>(await post())).data.planting_event.version).toBe(2);
    expect((await request(fx, `/planting-events/${eventId}`, 'DELETE', undefined, { 'If-Match': '2' })).status).toBe(200);
    const deletedReplay = await post();
    expect(deletedReplay.status).toBe(200);
    expect((await json<{ data: { planting_event: { deleted_at: number | null; version: number } } }>(deletedReplay)).data.planting_event).toMatchObject({ version: 3 });
    expect((await sql.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM journal_entries WHERE planting_event_id=$1`, [eventId]))[0]!.n).toBe(1);
  });

  it('seed and event deletes close their journal, checklist and photo cascades', async () => {
    const fx = await fixture(); const seedId = await makeSeed(fx);
    const eventId = uid('vwi-cascade-event');
    expect((await request(fx, '/planting-events', 'POST', { id: eventId, seed_id: seedId, kind: 'sowing', planned_for: '2026-06-15' })).status).toBe(200);
    const eventEntry = await sql.unsafe<{ id: string }[]>(`SELECT id FROM journal_entries WHERE planting_event_id=$1`, [eventId]);
    await sql.unsafe(`INSERT INTO journal_entry_photos (id,entry_id,household_id,storage_key,sort_order,created_at,updated_at) VALUES ($1,$2,$3,'test-key',0,$4,$4)`, [uid('vwi-photo'), eventEntry[0]!.id, fx.householdId, Date.now()]);
    expect((await request(fx, `/planting-events/${eventId}`, 'DELETE')).status).toBe(200);
    const journal = await sql.unsafe<{ deleted_at: number | null; version: number }[]>(`SELECT deleted_at,version FROM journal_entries WHERE id=$1`, [eventEntry[0]!.id]);
    expect(journal[0]!.deleted_at).not.toBeNull(); expect(journal[0]!.version).toBe(2);
    expect((await sql.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM journal_entry_photos WHERE entry_id=$1`, [eventEntry[0]!.id]))[0]!.n).toBe(0);
    const seedEntryId = uid('vwi-seed-entry'); await makeJournal(fx, seedEntryId, { seed_id: seedId });
    const deleted = await request(fx, `/seeds/${seedId}`, 'DELETE'); expect(deleted.status).toBe(200);
    const row = await sql.unsafe<{ deleted_at: number | null; version: number }[]>(`SELECT deleted_at,version FROM journal_entries WHERE id=$1`, [seedEntryId]);
    expect(row[0]!.deleted_at).not.toBeNull(); expect(row[0]!.version).toBe(2);
  });

  it('journal create versus delete leaves no child rows after either serialized outcome', async () => {
    const fx = await fixture(); const entryId = uid('vwi-race-entry'); await makeJournal(fx, entryId);
    const [created, deleted] = await Promise.all([
      request(fx, `/journal/${entryId}/checklist`, 'POST', { id: uid('vwi-race-item'), text: 'Water' }),
      request(fx, `/journal/${entryId}`, 'DELETE'),
    ]);
    expect([200, 400]).toContain(created.status); expect(deleted.status).toBe(200);
    const remaining = await sql.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM journal_checklist_items WHERE entry_id=$1`, [entryId]);
    expect(remaining[0]!.n).toBe(0);
    const replay = await makeJournal(fx, entryId);
    expect(replay.status).toBe(200);
    const version = created.status === 200 ? 3 : 2;
    expect((await json<{ data: { entry: { deletedAt: number | null; version: number } } }>(replay)).data.entry).toMatchObject({ version });
  });

  it('rolls back the entire seed cascade when a journal tombstone fails', async () => {
    const fx = await fixture(); const seedId = await makeSeed(fx); const eventId = uid('vwi-atomic-event');
    await request(fx, '/planting-events', 'POST', { id: eventId, seed_id: seedId, kind: 'sowing', planned_for: '2026-06-15' });
    const entry = await sql.unsafe<{ id: string }[]>(`SELECT id FROM journal_entries WHERE planting_event_id=$1`, [eventId]);
    const suffix = crypto.randomUUID().replaceAll('-', ''); const trigger = `vwi_fail_${suffix}`; const fn = `vwi_fail_fn_${suffix}`;
    await sql.unsafe(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.id = '${entry[0]!.id}' AND NEW.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'forced cascade failure'; END IF;
      RETURN NEW; END $$`);
    await sql.unsafe(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON journal_entries FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
    try {
      const failed = await request(fx, `/seeds/${seedId}`, 'DELETE');
      expect(failed.status).toBe(500);
      const state = await sql.unsafe<{ seed_deleted: number | null; event_deleted: number | null; seed_version: number; event_version: number }[]>(
        `SELECT s.deleted_at AS seed_deleted, pe.deleted_at AS event_deleted, s.version AS seed_version, pe.version AS event_version
           FROM seeds s JOIN planting_events pe ON pe.seed_id=s.id WHERE s.id=$1 AND pe.id=$2`, [seedId, eventId]);
      expect(state[0]).toMatchObject({ seed_deleted: null, event_deleted: null, seed_version: 1, event_version: 1 });
    } finally {
      await sql.unsafe(`DROP TRIGGER IF EXISTS ${trigger} ON journal_entries`);
      await sql.unsafe(`DROP FUNCTION IF EXISTS ${fn}()`);
    }
  });
});
