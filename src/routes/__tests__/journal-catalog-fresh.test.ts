import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createApp } from '../../index';
import type { Env } from '../../env';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://seedkeep:dev-only@localhost:55436/seedkeep';
if (!['localhost', '127.0.0.1', '::1'].includes(new URL(DATABASE_URL).hostname)) {
  throw new Error('Journal/catalog integration tests require loopback PostgreSQL');
}
const sql: Sql = postgres(DATABASE_URL, { onnotice: () => {} });
const env: Env = {
  PORT: 8787, APP_ENV: 'development', DATABASE_URL,
  S3_REGION: 'us-east-1', S3_ACCESS_KEY_ID: 'test-access-key', S3_SECRET_ACCESS_KEY: 'test-secret-key', S3_BUCKET: 'test-bucket', S3_FORCE_PATH_STYLE: false,
  BETTER_AUTH_SECRET: 'test-better-auth-secret-1234567890', ANTHROPIC_API_KEY: undefined,
  APPLE_IAP_SHARED_SECRET: undefined, ASSISTANT_KEY_MASTER: undefined,
  DEFAULT_VISION_MODEL: 'claude-sonnet-4-6', DEFAULT_REVIEW_MODEL: 'claude-haiku-4-5-20251001',
  ADMIN_SECRET: undefined, GARDEN_TOOLS_ENABLED: false,
};
const suffix = crypto.randomUUID();
const owner = { id: `fresh-owner-${suffix}`, session: `fresh-owner-session-${suffix}`, token: `fresh-owner-token-${suffix}` };
const member = { id: `fresh-member-${suffix}`, session: `fresh-member-session-${suffix}`, token: `fresh-member-token-${suffix}` };
const foreignOwner = { id: `fresh-foreign-owner-${suffix}`, session: `fresh-foreign-owner-session-${suffix}`, token: `fresh-foreign-owner-token-${suffix}` };
const garden = `fresh-garden-${suffix}`;
const foreignGarden = `fresh-foreign-garden-${suffix}`;
const localSeed = `fresh-seed-${suffix}`;
const foreignSeed = `fresh-foreign-seed-${suffix}`;
const raceSeed = `fresh-race-seed-${suffix}`;
const catalogId = `fresh-catalog-${suffix}`;
const sparseCatalogId = `fresh-sparse-catalog-${suffix}`;
const journalId = `fresh-journal-${suffix}`;
const raceJournalId = `fresh-race-journal-${suffix}`;
const quotaCatalogIds = Array.from({ length: 3 }, (_, i) => `fresh-quota-${i}-${suffix}`);
const app = createApp(env);

function headers(token: string, household = garden) {
  return { Authorization: `Bearer ${token}`, 'X-Household-Id': household, 'Content-Type': 'application/json' };
}
async function request(path: string, token: string, method: string, body: unknown, household = garden) {
  return app.request(path, { method, headers: headers(token, household), body: JSON.stringify(body) }, env);
}

describe('journal create and fresh manual catalog', () => {
  beforeAll(async () => {
    const now = Date.now();
    for (const user of [owner, member, foreignOwner]) {
      await sql.unsafe(`INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$1,$2,TRUE,$3,$3)`, [user.id, `${user.id}@example.invalid`, new Date(now)]);
      await sql.unsafe(`INSERT INTO session (id,"expiresAt",token,"createdAt","updatedAt","userId") VALUES ($1,NOW()+INTERVAL '1 day',$2,NOW(),NOW(),$3)`, [user.session, user.token, user.id]);
    }
    await sql.unsafe(`INSERT INTO households (id,name,created_at,updated_at) VALUES ($1,'Fresh journal garden',$2,$2),($3,'Foreign journal garden',$2,$2)`, [garden, now, foreignGarden]);
    await sql.unsafe(`INSERT INTO memberships (household_id,user_id,role,joined_at) VALUES ($1,$2,'owner',$3),($1,$4,'member',$3),($5,$6,'owner',$3)`, [garden, owner.id, now, member.id, foreignGarden, foreignOwner.id]);
    await sql.unsafe(`INSERT INTO seeds (id,household_id,state,created_at,updated_at) VALUES ($1,$2,'active',$3,$3),($4,$5,'active',$3,$3),($6,$2,'active',$3,$3)`, [localSeed, garden, now, foreignSeed, foreignGarden, raceSeed]);
  });

  afterAll(async () => {
    await sql`DELETE FROM journal_entries WHERE id = ${journalId}`;
    await sql`DELETE FROM journal_entries WHERE id = ${raceJournalId}`;
    await sql`DELETE FROM catalog_audit_log WHERE catalog_seed_id = ANY(${[catalogId, sparseCatalogId, ...quotaCatalogIds]}) OR catalog_seed_id = ${`${catalogId}-concurrent`}`;
    await sql`DELETE FROM catalog_seeds WHERE id = ${catalogId}`;
    await sql`DELETE FROM catalog_seeds WHERE id = ${sparseCatalogId}`;
    await sql`DELETE FROM catalog_seeds WHERE id = ANY(${[...quotaCatalogIds, `${catalogId}-concurrent`]})`;
    await sql`DELETE FROM seeds WHERE id = ANY(${[localSeed, foreignSeed, raceSeed]})`;
    await sql`DELETE FROM memberships WHERE household_id = ANY(${[garden, foreignGarden]})`;
    await sql`DELETE FROM households WHERE id = ANY(${[garden, foreignGarden]})`;
    await sql`DELETE FROM session WHERE id = ANY(${[owner.session, member.session, foreignOwner.session]})`;
    await sql`DELETE FROM "user" WHERE id = ANY(${[owner.id, member.id, foreignOwner.id]})`;
    await sql.end();
  });

  it('creates a journal row with a replay-safe client id and rejects invalid dates/references', async () => {
    const payload = { id: journalId, occurred_on: '2026-11-04', body: 'First note', seed_id: localSeed };
    const created = await request('/api/journal', owner.token, 'POST', payload);
    expect(created.status).toBe(200);
    const first = (await created.json() as any).data.entry;
    expect(first).toMatchObject({ id: journalId, occurredOn: '2026-11-04', body: 'First note', seedId: localSeed });
    const replay = await request('/api/journal', owner.token, 'POST', payload);
    expect(replay.status).toBe(200);
    expect((await replay.json() as any).data.entry.id).toBe(journalId);
    expect((await request('/api/journal', owner.token, 'POST', { ...payload, body: 'Changed' })).status).toBe(409);
    expect((await request('/api/journal', owner.token, 'POST', { ...payload, id: `${journalId}-bad-date`, occurred_on: '2026-02-30' })).status).toBe(400);
    expect((await request('/api/journal', owner.token, 'POST', { ...payload, id: `${journalId}-foreign`, seed_id: foreignSeed })).status).toBe(400);
    expect((await request('/api/journal', owner.token, 'POST', { ...payload, id: `${journalId}-multiple`, bed_id: 'other-parent' })).status).toBe(400);
    expect((await request(`/api/journal/${journalId}`, owner.token, 'PATCH', { occurred_on: '2026-02-30' })).status).toBe(400);
    expect((await request(`/api/journal/${journalId}`, owner.token, 'PATCH', { occurred_on: null })).status).toBe(400);
    expect((await request(`/api/journal/${journalId}`, owner.token, 'PATCH', { seed_id: foreignSeed })).status).toBe(400);
    expect((await request(`/api/journal/${journalId}`, owner.token, 'PATCH', { body: 42 })).status).toBe(400);
  });

  it('allows the production website origin to preflight catalog and journal headers', async () => {
    const productionEnv: Env = { ...env, APP_ENV: 'production', WEB_ORIGINS: 'https://seedkeep.finklea.dev' };
    const productionApp = createApp(productionEnv);
    const cases = [
      ['/api/catalog/example/feedback', 'authorization,content-type,idempotency-key,x-household-id'],
      ['/api/journal/example/photos', 'authorization,content-type,x-household-id,x-photo-width,x-photo-height'],
    ] as const;
    for (const [path, requestedHeaders] of cases) {
      const response = await productionApp.request(path, {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://seedkeep.finklea.dev',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': requestedHeaders,
        },
      }, productionEnv);
      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://seedkeep.finklea.dev');
      const allowed = response.headers.get('Access-Control-Allow-Headers')?.toLowerCase() ?? '';
      for (const header of requestedHeaders.split(',')) expect(allowed).toContain(header);
    }
  });

  it('serializes journal create and edit against a concurrent parent soft-delete', async () => {
    async function deleteParentWhileRequestRuns<T>(requestPromise: Promise<T>): Promise<void> {
      let acquired!: () => void;
      let release!: () => void;
      const parentLocked = new Promise<void>((resolve) => { acquired = resolve; });
      const continueDelete = new Promise<void>((resolve) => { release = resolve; });
      const deletion = sql.begin(async (tx) => {
        await tx`SELECT id FROM seeds WHERE id=${raceSeed} FOR UPDATE`;
        acquired();
        await continueDelete;
        const now = Date.now();
        await tx`UPDATE seeds SET deleted_at=${now}, updated_at=${now} WHERE id=${raceSeed}`;
      });
      await parentLocked;
      await new Promise((resolve) => setTimeout(resolve, 25));
      release();
      await deletion;
      const response = await requestPromise as Response;
      expect(response.status).toBe(400);
    }

    const create = request('/api/journal', owner.token, 'POST', {
      id: raceJournalId, occurred_on: '2026-11-04', body: 'Raced insert', seed_id: raceSeed,
    });
    await deleteParentWhileRequestRuns(create);
    expect((await sql`SELECT id FROM journal_entries WHERE id=${raceJournalId}`)).toHaveLength(0);

    await sql`UPDATE seeds SET deleted_at=NULL, updated_at=${Date.now()} WHERE id=${raceSeed}`;
    const edit = request(`/api/journal/${journalId}`, owner.token, 'PATCH', { seed_id: raceSeed });
    await deleteParentWhileRequestRuns(edit);
    expect((await sql`SELECT seed_id FROM journal_entries WHERE id=${journalId}`)[0]?.seed_id).toBe(localSeed);
  });

  it('publishes only from an owner, supports literal search, and reviews corrections by origin owner', async () => {
    const manual = await request('/api/catalog/manual', owner.token, 'POST', {
      id: catalogId, confirmed: true, common_name: 'Fresh Tomato', variety: 'Roma', company: 'Garden Co', barcode: '012345678905', days_to_maturity_min: 65,
    });
    expect(manual.status).toBe(201);
    const replay = await request('/api/catalog/manual', owner.token, 'POST', {
      id: catalogId, confirmed: true, common_name: 'Fresh Tomato', variety: 'Roma', company: 'Garden Co', barcode: '012345678905', days_to_maturity_min: 65,
    });
    expect(replay.status).toBe(200);
    expect((await request('/api/catalog/manual', owner.token, 'POST', {
      id: catalogId, confirmed: true, common_name: 'Different packet',
    })).status).toBe(409);
    expect((await request('/api/catalog/manual', foreignOwner.token, 'POST', {
      id: catalogId, confirmed: true, common_name: 'Fresh Tomato', variety: 'Roma', company: 'Garden Co', barcode: '012345678905', days_to_maturity_min: 65,
    }, foreignGarden)).status).toBe(409);
    expect((await request('/api/catalog/manual', member.token, 'POST', { id: `${catalogId}-member`, confirmed: true, common_name: 'No Owner' })).status).toBe(403);
    const concurrentId = `${catalogId}-concurrent`;
    const concurrentPayload = { id: concurrentId, confirmed: true, common_name: 'Concurrent Bean' };
    const concurrent = await Promise.all([
      request('/api/catalog/manual', owner.token, 'POST', concurrentPayload),
      request('/api/catalog/manual', owner.token, 'POST', concurrentPayload),
    ]);
    expect(concurrent.map((r) => r.status).sort()).toEqual([200, 201]);
    expect((await request('/api/catalog/manual', owner.token, 'POST', {
      id: catalogId, confirmed: true, common_name: 'Fresh Tomato', variety: 'Roma', company: 'Garden Co', barcode: '012345678905', days_to_maturity_min: 65,
    })).status).toBe(200);
    const search = await app.request('/api/catalog?q=Tomato&limit=10', { headers: { Authorization: `Bearer ${owner.token}` } }, env);
    expect((await search.json() as any).data.entries.some((entry: any) => entry.id === catalogId)).toBe(true);
    const escaped = await app.request('/api/catalog?q=%25&limit=10', { headers: { Authorization: `Bearer ${owner.token}` } }, env);
    expect((await escaped.json() as any).data.entries.some((entry: any) => entry.id === catalogId)).toBe(false);
    const barcode = await app.request('/api/catalog?barcode=012345678905', { headers: { Authorization: `Bearer ${owner.token}` } }, env);
    expect((await barcode.json() as any).data.entries.map((entry: any) => entry.id)).toContain(catalogId);

    const submitted = await request(`/api/catalog/${catalogId}/feedback`, member.token, 'POST', {
      body: 'Packet confirms this detail', field_name: 'instructions', suggested_value: 'Plant in full sun', client_seen_value: null,
    });
    expect(submitted.status).toBe(201);
    const correctionId = (await submitted.json() as any).data.id;
    expect((await app.request('/api/catalog/review-queue', { headers: headers(member.token) }, env)).status).toBe(403);
    const queue = await app.request('/api/catalog/review-queue?limit=10', { headers: headers(owner.token) }, env);
    const queued = (await queue.json() as any).data.corrections.find((x: any) => x.id === correctionId);
    expect(queued).toMatchObject({ current_value: null, suggested_value: 'Plant in full sun' });
    expect(queued.user_id).toBeUndefined();
    const foreignQueue = await app.request('/api/catalog/review-queue?limit=10', { headers: headers(foreignOwner.token, foreignGarden) }, env);
    expect((await foreignQueue.json() as any).data.corrections.some((x: any) => x.id === correctionId)).toBe(false);
    expect((await request(`/api/catalog/${catalogId}/corrections/${correctionId}/resolve`, foreignOwner.token, 'POST', { decision: 'dismiss', current_value: null }, foreignGarden)).status).toBe(404);
    expect((await request(`/api/catalog/${catalogId}/corrections/${correctionId}/resolve`, owner.token, 'POST', { decision: 'apply', current_value: 'stale' })).status).toBe(409);
    const applied = await request(`/api/catalog/${catalogId}/corrections/${correctionId}/resolve`, owner.token, 'POST', { decision: 'apply', current_value: null });
    expect(applied.status).toBe(200);
    const again = await request(`/api/catalog/${catalogId}/corrections/${correctionId}/resolve`, owner.token, 'POST', { decision: 'apply', current_value: null });
    expect(again.status).toBe(200);
    expect((await sql`SELECT instructions FROM catalog_seeds WHERE id=${catalogId}`)[0]?.instructions).toBe('Plant in full sun');
    expect((await sql`SELECT count(*)::int AS count FROM catalog_audit_log WHERE catalog_seed_id=${catalogId} AND field_name='__manual_publication__'`)[0]?.count).toBe(1);

    const dismissal = await request(`/api/catalog/${catalogId}/feedback`, member.token, 'POST', {
      body: 'Variety was entered incorrectly', field_name: 'variety', suggested_value: 'Roma Select', client_seen_value: 'Roma',
    });
    expect(dismissal.status).toBe(201);
    const dismissalId = (await dismissal.json() as any).data.id;
    const dismissed = await request(`/api/catalog/${catalogId}/corrections/${dismissalId}/resolve`, owner.token, 'POST', { decision: 'dismiss', current_value: 'Roma' });
    expect(dismissed.status).toBe(200);
    expect((await dismissed.json() as any).data.correction.status).toBe('dismissed');
    expect((await request(`/api/catalog/${catalogId}/corrections/${dismissalId}/resolve`, owner.token, 'POST', { decision: 'dismiss', current_value: 'Roma' })).status).toBe(200);
    expect((await request(`/api/catalog/${catalogId}/corrections/${dismissalId}/resolve`, owner.token, 'POST', { decision: 'apply', current_value: 'Roma' })).status).toBe(409);

    const unsafe = await request(`/api/catalog/${catalogId}/feedback`, member.token, 'POST', {
      body: 'Please review this packet text', field_name: 'instructions', suggested_value: '<script>alert(1)</script>', client_seen_value: 'Plant in full sun',
    });
    expect(unsafe.status).toBe(201);
    const unsafeId = (await unsafe.json() as any).data.id;
    expect((await request(`/api/catalog/${catalogId}/corrections/${unsafeId}/resolve`, owner.token, 'POST', { decision: ['dismiss'], current_value: 'Plant in full sun' })).status).toBe(400);
    expect((await request(`/api/catalog/${catalogId}/corrections/${unsafeId}/resolve`, owner.token, 'POST', { decision: 'apply', current_value: 'Plant in full sun' })).status).toBe(400);
    expect((await sql`SELECT instructions FROM catalog_seeds WHERE id=${catalogId}`)[0]?.instructions).toBe('Plant in full sun');

    await sql`UPDATE catalog_seeds SET days_to_maturity_max=70 WHERE id=${catalogId}`;
    const inverted = await request(`/api/catalog/${catalogId}/feedback`, member.token, 'POST', {
      body: 'This maturity range is wrong', field_name: 'days_to_maturity_min', suggested_value: '75', client_seen_value: '65',
    });
    expect(inverted.status).toBe(201);
    const invertedId = (await inverted.json() as any).data.id;
    expect((await request(`/api/catalog/${catalogId}/corrections/${invertedId}/resolve`, owner.token, 'POST', { decision: 'apply', current_value: '65' })).status).toBe(400);
    expect((await sql`SELECT days_to_maturity_min FROM catalog_seeds WHERE id=${catalogId}`)[0]?.days_to_maturity_min).toBe(65);
    expect((await sql`SELECT status FROM catalog_feedback WHERE id=${invertedId}`)[0]?.status).toBe('open');

  });

  it('does not enqueue low-confidence recommendation work without a provider key', async () => {
    await sql`UPDATE households SET home_zip='00000', latitude=39.75, longitude=-104.99, usda_zone='5a', avg_last_frost='05-15', avg_first_frost='10-01' WHERE id=${garden}`;
    const created = await request('/api/catalog/manual', owner.token, 'POST', {
      id: sparseCatalogId, confirmed: true, common_name: 'Unknown Test Crop',
    });
    expect(created.status).toBe(201);
    const response = await request('/api/recommendations/bulk', owner.token, 'POST', { catalogSeedIds: [sparseCatalogId] });
    expect(response.status).toBe(200);
    const data = (await response.json() as any).data;
    expect(data.pending).toEqual([]);
    expect(data.recommendations).toHaveLength(1);
    expect(data.recommendations[0].verdict === 'unknown' || data.recommendations[0].recommendedRange !== null).toBe(true);
    expect((await sql`SELECT count(*)::int AS count FROM recommendation_jobs WHERE catalog_seed_id=${sparseCatalogId}`)[0]?.count).toBe(0);
    const priorQuota = await request('/api/catalog/manual', owner.token, 'POST', {
      id: quotaCatalogIds[0], confirmed: true, common_name: `Quota Crop ${quotaCatalogIds[0].slice(0, 18)}`,
    });
    expect(priorQuota.status).toBe(201);
    const atQuotaCandidates = quotaCatalogIds.slice(1).map((id) => ({
      id,
      body: { id, confirmed: true, common_name: `Quota Crop ${id.slice(0, 18)}` },
    }));
    const atQuota = await Promise.all(atQuotaCandidates.map(async (candidate) => ({
      ...candidate,
      response: await request('/api/catalog/manual', owner.token, 'POST', candidate.body),
    })));
    expect(atQuota.map(({ response }) => response.status).sort()).toEqual([201, 429]);
    const successful = atQuota.find(({ response }) => response.status === 201)!;
    expect((await request('/api/catalog/manual', owner.token, 'POST', successful.body)).status).toBe(200);
    expect((await sql`SELECT count(*)::int AS count FROM catalog_audit_log WHERE actor_user_id=${owner.id} AND field_name='__manual_publication__'`)[0]?.count).toBe(5);
    expect((await request('/api/catalog/manual', owner.token, 'POST', {
      id: catalogId, confirmed: true, common_name: 'Fresh Tomato', variety: 'Roma', company: 'Garden Co', barcode: '012345678905', days_to_maturity_min: 65,
    })).status).toBe(200);
  });
});
