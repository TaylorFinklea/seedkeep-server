import { describe, expect, it } from 'vitest';
import { AUTH_PEER_IP_HEADER, prepareRequestPeer, requestWithSocketPeer } from '../requestPeer';

describe('requestWithSocketPeer', () => {
  it('replaces a forged private peer header with the socket-derived address', () => {
    const request = new Request('https://server.example/api/auth/get-session', {
      headers: {
        [AUTH_PEER_IP_HEADER]: '198.51.100.99',
        'x-forwarded-for': '203.0.113.77',
      },
    });
    const bound = requestWithSocketPeer(request, '192.0.2.4');
    expect(bound.headers.get(AUTH_PEER_IP_HEADER)).toBe('192.0.2.4');
    expect(bound.headers.get('x-forwarded-for')).toBe('203.0.113.77');
  });

  it('removes a forged private peer header when the socket peer is unavailable', () => {
    const request = new Request('https://server.example/api/auth/get-session', {
      headers: { [AUTH_PEER_IP_HEADER]: '198.51.100.99' },
    });
    expect(requestWithSocketPeer(request, undefined).headers.has(AUTH_PEER_IP_HEADER)).toBe(false);
  });

  it('fails closed for auth endpoints when the socket peer is unavailable', async () => {
    const request = new Request('https://server.example/api/auth/get-session', {
      headers: { [AUTH_PEER_IP_HEADER]: '198.51.100.99' },
    });
    const prepared = prepareRequestPeer(request, undefined);
    expect(prepared).toBeInstanceOf(Response);
    if (prepared instanceof Response) expect(prepared.status).toBe(503);
  });
});
