import { NextResponse, type NextRequest } from 'next/server';
import { verifyToken, createToken, SESSION_COOKIE, SESSION_MINUTES } from '@/lib/auth';

/** Paths reachable without a session (the login page + its API routes). */
const PUBLIC = ['/login', '/api/login', '/api/logout'];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }

  const session = await verifyToken(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    // Not authenticated (or the session timed out) → send to login.
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    url.searchParams.set('from', pathname);
    const res = NextResponse.redirect(url);
    res.cookies.delete(SESSION_COOKIE);
    return res;
  }

  // Sliding expiration: refresh the cookie so the timeout is measured from the
  // user's last activity, not from login.
  const res = NextResponse.next();
  res.cookies.set(SESSION_COOKIE, await createToken(session.u), {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MINUTES * 60,
  });
  return res;
}

export const config = {
  // Run on every request except Next internals and static asset files.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt)$).*)'],
};
