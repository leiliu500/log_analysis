import { NextResponse, type NextRequest } from 'next/server';
import { checkCredentials, createToken, SESSION_COOKIE, SESSION_MINUTES } from '@/lib/auth';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { username?: unknown; password?: unknown };
  const username = String(body.username ?? '');
  const password = String(body.password ?? '');

  if (!checkCredentials(username, password)) {
    return NextResponse.json({ error: 'Invalid username or password' }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, await createToken(username), {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MINUTES * 60,
  });
  return res;
}
