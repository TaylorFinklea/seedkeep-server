import { createMiddleware } from 'hono/factory';
import { nanoid } from 'nanoid';

/**
 * Wraps every JSON response in `{ ok, data | error, request_id }` and
 * attaches `x-request-id` to the headers. Identical to the Workers
 * version — Hono is runtime-agnostic.
 *
 * Observability floor:
 * - 5xx errors: log a structured JSON line server-side; return a generic
 *   message to clients so internal details are never leaked.
 * - All responses >= 400 (excluding /api/health): log a one-line completion
 *   record with method, path, status, duration_ms, request_id, and userId
 *   when available.
 */
export const envelope = () =>
  createMiddleware(async (c, next) => {
    const requestId = nanoid(12);
    c.header('x-request-id', requestId);
    const startMs = Date.now();

    try {
      await next();

      // One-line completion log for >= 400, skipping the health probe.
      const status = c.res.status;
      if (status >= 400 && c.req.path !== '/api/health') {
        const userId = c.get('userId') as string | undefined;
        const rec: Record<string, unknown> = {
          request_id: requestId,
          method: c.req.method,
          path: c.req.path,
          status,
          duration_ms: Date.now() - startMs,
        };
        if (userId) rec.userId = userId;
        console.log(JSON.stringify(rec));
      }
    } catch (err) {
      const originalMessage = err instanceof Error ? err.message : String(err);
      const status = (err as { status?: number }).status ?? 500;
      const code =
        status === 401 ? 'unauthorized' :
        status === 403 ? 'forbidden' :
        status === 404 ? 'not_found' :
        status >= 400 && status < 500 ? 'bad_request' :
        'internal_error';

      if (status >= 500) {
        const userId = c.get('userId') as string | undefined;
        const rec: Record<string, unknown> = {
          request_id: requestId,
          method: c.req.method,
          path: c.req.path,
          status,
          message: originalMessage,
          stack: err instanceof Error ? err.stack : undefined,
        };
        if (userId) rec.userId = userId;
        console.error(JSON.stringify(rec));
      } else if (c.req.path !== '/api/health') {
        const userId = c.get('userId') as string | undefined;
        const rec: Record<string, unknown> = {
          request_id: requestId,
          method: c.req.method,
          path: c.req.path,
          status,
          duration_ms: Date.now() - startMs,
        };
        if (userId) rec.userId = userId;
        console.log(JSON.stringify(rec));
      }

      // Never leak internal error details to the client for 5xx.
      const clientMessage = status >= 500 ? 'Internal server error' : originalMessage;
      return c.json(
        {
          ok: false,
          error: { code, message: clientMessage },
          request_id: requestId,
        },
        status as 400,
      );
    }
  });
