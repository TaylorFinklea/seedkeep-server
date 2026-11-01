import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../index';
import type { Env } from '../../env';

const { getSqlMock } = vi.hoisted(() => ({ getSqlMock: vi.fn() }));
vi.mock('../../db/client', () => ({ getSql: getSqlMock }));


const testEnv = { APP_ENV: 'production' } as Env;

function createHealthApp() {
  return createApp(testEnv);
}

describe('GET /api/health worker state readiness', () => {
  beforeEach(() => getSqlMock.mockReset());

  it('returns healthy when the required worker state table is readable', async () => {
    const unsafe = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { k: 'worker_last_tick', v: String(Date.now()) },
        { k: 'backup_last_success_ymd', v: new Date().toISOString().slice(0, 10) },
      ]);
    getSqlMock.mockReturnValue({ unsafe });

    const response = await createHealthApp().request('/api/health', undefined, testEnv);
    const body = await response.json() as { ok: boolean; data: { status: string } };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe('healthy');
  });

  it.each([
    ['migration is missing', new Error('relation _seedkeep_kv does not exist')],
    ['runtime role cannot read the table', new Error('permission denied for table _seedkeep_kv')],
  ])('fails readiness when the worker state table is unavailable (%s)', async (_label, error) => {
    const unsafe = vi.fn()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(error);
    getSqlMock.mockReturnValue({ unsafe });

    const response = await createHealthApp().request('/api/health', undefined, testEnv);
    const body = await response.json() as { ok: boolean; error: { message: string } };
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.error.message).toBe('Required worker state is unavailable');
    expect(serialized).not.toContain(error.message);
  });
});
