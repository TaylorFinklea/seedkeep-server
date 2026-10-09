import { describe, expect, it } from 'vitest';
import { isCookieFreeOAuthEndpoint } from '../auth';

describe('cookie-free OAuth exemptions', () => {
  it.each([
    ['/oauth2/token', 'POST', true],
    ['/oauth2/register', 'POST', true],
    ['/oauth2/userinfo', 'GET', true],
    ['/mcp/token', 'POST', true],
    ['/mcp/register', 'POST', true],
    ['/oauth2/consent', 'POST', false],
    ['/oauth2/authorize', 'POST', false],
    ['/mcp/authorize', 'POST', false],
    ['/mcp/get-session', 'POST', false],
    ['/oauth2/token', 'GET', false],
    ['/oauth2/userinfo', 'POST', false],
  ])('exempts only %s %s as cookie-free', (path, method, expected) => {
    expect(isCookieFreeOAuthEndpoint(path, method)).toBe(expected);
  });
});
