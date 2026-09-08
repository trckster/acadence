// Only explicitly constructed diagnostics may bypass the CLI's secret filter.
export class RequestError extends Error {}

export function networkReason(error: unknown, seen = new Set<unknown>()): string {
  if (!error || typeof error !== 'object' || seen.has(error)) return 'network request failed';
  seen.add(error);
  const value = error as { name?: string; code?: string; cause?: unknown; errors?: unknown[] };
  if (value.name === 'TimeoutError' || value.code === 'ETIMEDOUT' || value.code === 'UND_ERR_CONNECT_TIMEOUT') return 'connection timed out';
  if (value.name === 'AbortError') return 'request aborted';
  const reasons: Record<string, string> = {
    ENOTFOUND: 'DNS lookup failed', EAI_AGAIN: 'DNS lookup temporarily failed',
    ECONNREFUSED: 'connection refused', ECONNRESET: 'connection reset',
    ENETUNREACH: 'network unreachable', EHOSTUNREACH: 'host unreachable',
    CERT_HAS_EXPIRED: 'TLS certificate expired', DEPTH_ZERO_SELF_SIGNED_CERT: 'TLS certificate is self-signed',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS certificate could not be verified',
    ERR_TLS_CERT_ALTNAME_INVALID: 'TLS certificate does not match the host',
    UND_ERR_SOCKET: 'connection closed', UND_ERR_HEADERS_TIMEOUT: 'response headers timed out',
    UND_ERR_BODY_TIMEOUT: 'response body timed out'
  };
  if (value.code && reasons[value.code]) return `${reasons[value.code]} (${value.code})`;
  if (value.cause) return networkReason(value.cause, seen);
  if (Array.isArray(value.errors)) return [...new Set(value.errors.map(item => networkReason(item, seen)))].join('; ') || 'network request failed';
  return 'network request failed';
}

// Do not expose request headers, bodies, URL credentials, query strings or Telegram bot tokens.
export function requestTarget(url: string, method: string): string {
  const target = new URL(url);
  const path = target.hostname === 'api.telegram.org' ? target.pathname.replace(/^\/bot[^/]+/, '/bot[redacted]') : target.pathname;
  return `${method} ${target.origin}${path}`;
}

export async function fetchWithContext(url: string, options: RequestInit): Promise<Response> {
  try { return await fetch(url, options); }
  catch (error) { throw new RequestError(`${requestTarget(url, options.method ?? 'GET')}: ${networkReason(error)}`); }
}

export async function responseJson(response: Response, url: string, method: string): Promise<any> {
  try { return await response.json(); }
  catch (error) {
    const reason = error instanceof SyntaxError ? 'expected a JSON response' : `could not read response: ${networkReason(error)}`;
    throw new RequestError(`${requestTarget(url, method)}: HTTP ${response.status}; ${reason}`);
  }
}

export function formatError(error: unknown): string {
  if (error instanceof RequestError) return error.message;
  return error instanceof Error && !/token|secret|credential/i.test(error.message)
    ? error.message : 'Operation failed; check your sign-in and connection';
}

export function providerErrorMessage(code: string): string {
  return ({ auth: 'authentication expired or rejected; run acadence reauth',
    unavailable: 'provider unavailable', quota_schema: 'unsupported provider usage format',
    rate_limit: 'provider rate limit reached' } as Record<string, string>)[code] ?? code;
}
