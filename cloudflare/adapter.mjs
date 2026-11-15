const MAX_BODY_BYTES = 128 * 1024;
// Security headers for every static page and asset. Inline <script>/<style> blocks are
// still used by the pages, so 'unsafe-inline' is required until they are moved to files or hashed.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://unpkg.com",
  "style-src 'self' 'unsafe-inline' https://unpkg.com",
  "img-src 'self' data: https://tile.openstreetmap.org https://unpkg.com",
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://photon.komoot.io",
  "font-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'",
  "frame-ancestors 'none'"
].join('; ');
export const STATIC_SECURITY_HEADERS = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(self), camera=(), microphone=(), payment=()',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains'
};
const NATIVE_APP_ORIGINS = ['capacitor://localhost', 'https://localhost', 'ionic://localhost'];
const corsHeaders = origin => ({'Access-Control-Allow-Origin': origin, 'Vary': 'Origin'});
async function withSecurityHeaders(responsePromise) {
  const response = await responsePromise;
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(STATIC_SECURITY_HEADERS)) headers.set(name, value);
  return new Response(response.body, {status: response.status, statusText: response.statusText, headers});
}

function json(status, payload, headers = {}) {
  return new Response(JSON.stringify(payload), {status, headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', ...headers
  }});
}

async function readBody(request) {
  if (!request.body) return undefined;
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) {
    throw { status: 415, message: 'JSON request required' };
  }
  const reader = request.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw {status: 413, message: 'Request too large'};
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)); }
  catch { throw {status: 400, message: 'Invalid JSON request'}; }
}

export function createWorker(routes, {releaseEnvironment='staging'}={}) {
  if (!['staging','production'].includes(releaseEnvironment)) throw new Error('Unknown release environment');
  const projectRef = releaseEnvironment === 'production' ? 'tsosredghislnehfyypi' : 'ctztwqcsizwkrqgpgrgg';
  const handle = async (request, env) => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      if (url.pathname === '/') {
        url.pathname = '/index.html';
        return withSecurityHeaders(env.ASSETS.fetch(new Request(url, request)));
      }
      return withSecurityHeaders(env.ASSETS.fetch(request));
    }
    // The entry point pins the environment: changing dashboard variables cannot
    // turn staging into production. Never copy bindings into a shared global.
    if (env.APP_ENV !== releaseEnvironment || env.CLOUDFLARE_RELEASE_ENV !== releaseEnvironment ||
        process.env.APP_ENV !== env.APP_ENV ||
        env.SUPABASE_EXPECTED_PROJECT_REF !== projectRef ||
        env.SUPABASE_URL !== `https://${projectRef}.supabase.co` ||
        process.env.SUPABASE_URL !== env.SUPABASE_URL ||
        process.env.SUPABASE_EXPECTED_PROJECT_REF !== env.SUPABASE_EXPECTED_PROJECT_REF ||
        !env.SUPABASE_SECRET_KEY || !env.SUPABASE_PUBLISHABLE_KEY ||
        process.env.SUPABASE_SECRET_KEY !== env.SUPABASE_SECRET_KEY ||
        process.env.SUPABASE_PUBLISHABLE_KEY !== env.SUPABASE_PUBLISHABLE_KEY ||
        process.env.SITE_URL !== env.SITE_URL ||
        (releaseEnvironment === 'production' && (env.TYMRAK_RELEASE_READY !== 'true' ||
          env.SITE_URL !== 'https://app.tymrak.com'))) {
      return json(503, {error: 'Release configuration unavailable'});
    }
    const handler = Object.hasOwn(routes, url.pathname) ? routes[url.pathname] : null;
    if (!handler) return json(404, {error: 'Endpoint not found'});
    try {
      const query = Object.create(null);
      for (const key of new Set(url.searchParams.keys())) {
        const values = url.searchParams.getAll(key);
        query[key] = values.length > 1 ? values : values[0];
      }
      const req = {method: request.method, headers: Object.fromEntries(request.headers),
        query, body: await readBody(request)};
      let status = 200, response;
      const headers = {};
      const res = {
        setHeader(name, value) { headers[name] = String(value); return this; },
        status(code) { status = code; return this; },
        json(payload) { response = json(status, payload, headers); return this; }
      };
      await handler(req, res);
      return response || json(500, {error: 'Unable to complete request'});
    } catch (error) {
      const known = [400, 413, 415].includes(error?.status);
      return json(known ? error.status : 500, {error: known ? error.message : 'Unable to complete request'});
    }
  };
  // Cross-origin access is allowed only for the installed native app shells (Capacitor/Ionic).
  // Requests authenticate with a Bearer token, never cookies, so credentials are not allowed.
  return { async fetch(request, env) {
    const url = new URL(request.url), origin = request.headers.get('Origin');
    const native = url.pathname.startsWith('/api/') && NATIVE_APP_ORIGINS.includes(origin);
    if (native && request.method === 'OPTIONS') {
      return new Response(null, {status: 204, headers: {...corsHeaders(origin),
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '600'}});
    }
    const response = await handle(request, env);
    if (!native) return response;
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(corsHeaders(origin))) headers.set(name, value);
    return new Response(response.body, {status: response.status, statusText: response.statusText, headers});
  }};
}
