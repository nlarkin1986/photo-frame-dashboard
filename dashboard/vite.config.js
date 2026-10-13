import { defineConfig, loadEnv } from 'vite';
import { GET as img } from './api/img.js';
import { GET as photo } from './api/photo.js';
import { GET as photos } from './api/photos.js';
import { GET as scheduleGet, POST as schedulePost } from './api/schedule.js';
import { GET as schedulePhoto } from './api/schedule-photo.js';
import { GET as boardGet, POST as boardPost } from './api/board.js';
import { GET as agentBoard } from './api/agent/board.js';
import { POST as agentShopping } from './api/agent/shopping/items.js';
import { PATCH as agentItemPatch, DELETE as agentItemDelete } from './api/agent/shopping/items/[id].js';
import { PUT as agentChores } from './api/agent/chores.js';
import { PUT as agentBrief } from './api/agent/brief/[week].js';
import { GET as agentChanges } from './api/agent/changes.js';
import { GET as agentShoppingUpdates } from './api/agent/shopping/updates.js';
import { GET as agentOpenapi } from './api/agent/openapi.js';
import { GET as weatherGet } from './api/weather.js';
import { GET as calendarGet } from './api/calendar.js';
import { GET as mcpGet, POST as mcpPost, DELETE as mcpDelete } from './api/mcp.js';

// Serve the api/ functions locally too, so dev and preview behave the way Vercel does.
// They read the Blob token from .env.local (`vercel env pull`). Without DHC_ORIGIN the
// schedule functions serve lib/schedule-fixture.js instead of DHC tools. Without Upstash env the
// board uses an in-memory store (seeded from lib/board/fixture.js when present); set
// BOARD_DEV_TOKEN in .env.local to curl the agent API locally.
Object.assign(process.env, loadEnv('development', process.cwd(), ''));
// Matched on the exact path (not connect's prefix match), so /api/schedule never takes
// /api/schedule-photo and /api/photo never takes /api/photos.
const routes = {
  '/api/img': { GET: img },
  '/api/photo': { GET: photo },
  '/api/photos': { GET: photos },
  '/api/schedule': { GET: scheduleGet, POST: schedulePost },
  '/api/schedule-photo': { GET: schedulePhoto },
  '/api/board': { GET: boardGet, POST: boardPost },
  '/api/weather': { GET: weatherGet },
  '/api/calendar': { GET: calendarGet },
  '/api/agent/board': { GET: agentBoard },
  '/api/agent/shopping/items': { POST: agentShopping },
  '/api/agent/chores': { PUT: agentChores },
  '/api/agent/changes': { GET: agentChanges },
  '/api/agent/shopping/updates': { GET: agentShoppingUpdates },
  '/api/agent/openapi': { GET: agentOpenapi },
  '/api/agent/openapi.json': { GET: agentOpenapi },
  '/api/mcp': { GET: mcpGet, POST: mcpPost, DELETE: mcpDelete },
};
// Vercel dynamic routes (api/agent/shopping/items/[id].js, api/agent/brief/[week].js); the
// handlers read the parameter from the URL themselves.
const dynamicRoutes = [
  [/^\/api\/agent\/shopping\/items\/[^/]+$/, { PATCH: agentItemPatch, DELETE: agentItemDelete }],
  [/^\/api\/agent\/brief\/[^/]+$/, { PUT: agentBrief }],
];
function match(path) {
  if (routes[path]) return routes[path];
  const hit = dynamicRoutes.find(([re]) => re.test(path));
  return hit ? hit[1] : null;
}
const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'expect', 'te', 'trailer', 'proxy-connection']);
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function mount(middlewares) {
  middlewares.use(async (req, res, next) => {
    const url = req.originalUrl || req.url;
    const methods = match(url.split('?')[0]);
    if (!methods) return next();
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    const handler = methods[method];
    if (!handler) {
      res.statusCode = 405;
      res.setHeader('Allow', Object.keys(methods).join(', '));
      return res.end();
    }
    try {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v == null || HOP.has(k)) continue;
        headers.set(k, Array.isArray(v) ? v.join(', ') : v);
      }
      const body = method === 'GET' || method === 'DELETE' ? undefined : await readBody(req);
      const r = await handler(new Request(`http://${req.headers.host || 'localhost'}${url}`, { method, headers, body }));
      res.statusCode = r.status;
      r.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(req.method === 'HEAD' ? undefined : Buffer.from(await r.arrayBuffer()));
    } catch (e) {
      console.error(`[api] ${req.method} ${url.split('?')[0]}:`, e && e.message);
      res.statusCode = 500;
      res.end('Internal error');
    }
  });
}
const apiPlugin = {
  name: 'vercel-api',
  configureServer(server) { mount(server.middlewares); },
  configurePreviewServer(server) { mount(server.middlewares); },
};

// The wall tablet runs Android WebView 106 — keep JS output within Chromium 106.
// CSS targets chrome61 on purpose: the tablet's WebView rejects 4/8-digit hex colours (#0000,
// #ffffffbf) even though Chrome 106 should support them, and a newer target lets the minifier
// rewrite transparent/rgba() into that form. Verified on-device with CSS.supports().
export default defineConfig({
  plugins: [apiPlugin],
  build: {
    target: 'chrome106',
    cssTarget: 'chrome61',
  },
  server: { host: true },
});
