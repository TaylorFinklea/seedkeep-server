import { createMiddleware } from 'hono/factory';
import { nanoid } from 'nanoid';

/**
 * Wraps every JSON response in `{ ok, data | error, request_id }` and
 * attaches `x-request-id` to the headers. Identical to the Workers
 * version — Hono is runtime-agnostic.
 */
export const envelope = () =>
  createMiddleware(async (c, next) => {
    const requestId = nanoid(12);
    c.header('x-request-id', requestId);

    try {
      await next();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = (err as { status?: number }).status ?? 500;
      const code =
        status === 401 ? 'unauthorized' :
        status === 403 ? 'forbidden' :
        status === 404 ? 'not_found' :
        status >= 400 && status < 500 ? 'bad_request' :
        'internal_error';
      return c.json(
        {
          ok: false,
          error: { code, message },
          request_id: requestId,
        },
        status as 400,
      );
    }
  });
