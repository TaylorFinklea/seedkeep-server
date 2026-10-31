export const AUTH_PEER_IP_HEADER = 'x-seedkeep-socket-peer-ip';

export function prepareRequestPeer(request: Request, peerAddress: string | undefined): Request | Response {
  const path = new URL(request.url).pathname;
  if (!peerAddress && (path === '/api/auth' || path.startsWith('/api/auth/'))) {
    return new Response('Authentication requires a verified connection peer.', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  return requestWithSocketPeer(request, peerAddress);
}

/** Replace the private Better Auth peer header with Bun's socket-derived IP. */
export function requestWithSocketPeer(request: Request, peerAddress: string | undefined): Request {
  const headers = new Headers(request.headers);
  headers.delete(AUTH_PEER_IP_HEADER);
  if (peerAddress) headers.set(AUTH_PEER_IP_HEADER, peerAddress);
  return new Request(request, { headers });
}
