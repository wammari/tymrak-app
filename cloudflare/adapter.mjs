const MAX_BODY_BYTES = 128 * 1024;
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

export function createWorker(routes) {
  return { async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      if (url.pathname === '/') {
        url.pathname = '/index.html';
        return env.ASSETS.fetch(new Request(url, request));
      }
      return env.ASSETS.fetch(request);
    }
    // This candidate is deliberately staging-only. Bindings populate process.env
    // through nodejs_compat; never copy per-request values into a shared global.
    if (env.APP_ENV !== 'staging' || env.CLOUDFLARE_RELEASE_ENV !== 'staging' ||
        process.env.APP_ENV !== env.APP_ENV ||
        env.SUPABASE_EXPECTED_PROJECT_REF !== 'ctztwqcsizwkrqgpgrgg' ||
        env.SUPABASE_URL !== 'https://ctztwqcsizwkrqgpgrgg.supabase.co' ||
        process.env.SUPABASE_URL !== env.SUPABASE_URL ||
        process.env.SUPABASE_SECRET_KEY !== env.SUPABASE_SECRET_KEY) {
      return json(503, {error: 'Staging configuration unavailable'});
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
  }};
}
