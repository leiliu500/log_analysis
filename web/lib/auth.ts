/**
 * Minimal session auth for the web UI, dependency-free. A signed, HttpOnly cookie
 * holds `{ user, exp }`; the signature is an HMAC-SHA256 over the payload using
 * Web Crypto, so the SAME code runs in the Edge middleware and in the Node route
 * handlers. Credentials, secret and timeout come from env (with dev defaults).
 *
 * This gates the web pages only. The backend API is a separate origin (called from
 * the browser via NEXT_PUBLIC_API_BASE_URL) and is not protected by this cookie.
 */
const SECRET = process.env.AUTH_SECRET || 'agentic-log-dev-secret-change-me';

/** Idle/session timeout in minutes (sliding — refreshed on each request). */
export const SESSION_MINUTES = Number(process.env.SESSION_TIMEOUT_MINUTES || '30');
export const SESSION_COOKIE = 'agentic_log_session';

const encoder = new TextEncoder();

function toB64Url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64Url(s: string): string {
  return atob(s.replace(/-/g, '+').replace(/_/g, '/'));
}

async function sign(payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return toB64Url(sig);
}

/** Create a signed session token that expires `ttlMinutes` from now. */
export async function createToken(user: string, ttlMinutes = SESSION_MINUTES): Promise<string> {
  const exp = Date.now() + ttlMinutes * 60_000;
  const payload = toB64Url(encoder.encode(JSON.stringify({ u: user, exp })));
  return `${payload}.${await sign(payload)}`;
}

/** Verify signature + expiry; returns the session, or null if invalid/expired. */
export async function verifyToken(token?: string | null): Promise<{ u: string; exp: number } | null> {
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot < 1) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if ((await sign(payload)) !== sig) return null;
  try {
    const data = JSON.parse(fromB64Url(payload)) as { u: string; exp: number };
    if (!data || typeof data.exp !== 'number' || data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

/** Validate a username/password against the configured credentials. */
export function checkCredentials(user: string, password: string): boolean {
  const U = process.env.AUTH_USERNAME || 'lliu';
  const P = process.env.AUTH_PASSWORD || 'Password123!';
  return user === U && password === P;
}
