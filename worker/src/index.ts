import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types';
import { createPublicRoutes } from './routes/public';
import { createAdminRoutes, parseAllowedOrigins } from './routes/admin';
import { maybeSendStorageAlert, runStorageCleanup } from './services/cleanup';

export function createApp() {
  const app = new Hono<{ Bindings: Env }>();

  // Global security headers + clear cached QUIC Alt-Svc hints where honored
  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    c.header('Alt-Svc', 'clear');
    if (!c.req.path.startsWith('/f/')) {
      c.header('X-Frame-Options', 'DENY');
    }
  });

  // Ensure unexpected errors on /api/* still return CORS headers and JSON
  app.onError((err, c) => {
    console.error('Unhandled Worker error:', err instanceof Error ? err.message : err);
    const headers = new Headers({ 'Content-Type': 'application/json' });
    const origin = c.req.header('Origin');
    if (origin && c.req.path.startsWith('/api/')) {
      const allowed = parseAllowedOrigins(c.env, c.req.url);
      if (allowed.includes(origin)) {
        headers.set('Access-Control-Allow-Origin', origin);
        headers.set('Access-Control-Allow-Credentials', 'true');
        headers.set('Vary', 'Origin');
      }
    }
    return new Response(JSON.stringify({ error: 'Internal server error. Please try again.' }), {
      status: 500,
      headers,
    });
  });

  // Strict CORS on /api/* allowing only GitHub Pages (and localhost during local dev)
  app.use('/api/*', async (c, next) => {
    const allowed = parseAllowedOrigins(c.env, c.req.url);
    const corsMiddleware = cors({
      origin: (origin) => (origin && allowed.includes(origin) ? origin : ''),
      allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: [
        'Content-Type',
        'X-Requested-With',
        'X-File-Name',
        'X-File-Category',
        'X-Turnstile-Token',
        'X-Delete-Token',
        'X-Reserved-Id',
        'X-Reserve-Token',
        'X-Reserve-Next',
        'X-Source-Id',
      ],
      credentials: true,
      maxAge: 86400,
    });
    return corsMiddleware(c, next);
  });

  app.route('/', createPublicRoutes());
  app.route('/api/admin', createAdminRoutes());

  return app;
}

const app = createApp();

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const now = Date.now();
    ctx.waitUntil(
      (async () => {
        await runStorageCleanup({ env, trigger: 'daily', now });
        await maybeSendStorageAlert(env, now);

        // Housekeeping: prune expired sessions, expired resets, and old rate-limit buckets
        const staleRateCutoff = now - 24 * 60 * 60 * 1000;
        await env.DB.batch([
          env.DB.prepare('DELETE FROM admin_sessions WHERE expires_at < ?').bind(now),
          env.DB.prepare('DELETE FROM password_resets WHERE expires_at < ?').bind(now),
          env.DB.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(staleRateCutoff),
          env.DB.prepare('DELETE FROM upload_reservations WHERE expires_at < ?').bind(now),
        ]);
      })()
    );
  },
};
