const page = __SITE_HTML__;
const loginPage = __LOGIN_HTML__;
const cookieName = '__Host-gn-session';
const lifetime = 7 * 24 * 60 * 60;
const attempts = new Map();
const encoder = new TextEncoder();
const headers = {
  'Cache-Control': 'private, no-store, max-age=0',
  'Vary': 'Cookie',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};
function reply(body, status = 200, extra = {}, head = false) {
  return new Response(head ? null : body, {status, headers: {...headers, 'Content-Type': 'text/plain; charset=utf-8', ...extra}});
}
function login(error = '', status = 200, head = false) {
  return reply(loginPage.replace('__ERROR__', error), status, {'Content-Type': 'text/html; charset=utf-8'}, head);
}
function hex(bytes) { return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join(''); }
async function same(a, b) {
  const [x, y] = await Promise.all([a, b].map(v => crypto.subtle.digest('SHA-256', encoder.encode(v))));
  const left = new Uint8Array(x), right = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}
async function sign(value, env) {
  // Including the current password revokes existing cookies when it changes.
  const key = await crypto.subtle.importKey('raw', encoder.encode(env.SESSION_SECRET + ':' + env.SITE_PASSWORD), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}
async function authenticated(request, env) {
  const token = (request.headers.get('Cookie') || '').split(';').map(v => v.trim()).find(v => v.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
  if (!token || token.length > 180) return false;
  const match = /^(\d{10})\.([a-f0-9]{32})\.([a-f0-9]{64})$/.exec(token);
  if (!match) return false;
  const now = Math.floor(Date.now() / 1000), expires = Number(match[1]);
  if (expires <= now || expires > now + lifetime) return false;
  return same(match[3], await sign(match[1] + '.' + match[2], env));
}
async function readBody(request) {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = []; let length = 0;
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    length += value.length;
    if (length > 2048) { await reader.cancel(); throw new Error('body too large'); }
    chunks.push(value);
  }
  const body = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(body);
}
export default {
  async fetch(request, env) {
    const head = request.method === 'HEAD', url = new URL(request.url);
    if (typeof env.SITE_PASSWORD !== 'string' || !env.SITE_PASSWORD || typeof env.SESSION_SECRET !== 'string' || env.SESSION_SECRET.length < 32) {
      return reply('Вход временно недоступен.', 503, {}, head);
    }
    if (request.method === 'POST' && ['/login', '/logout'].includes(url.pathname)) {
      if (request.headers.get('Origin') !== url.origin) return reply('Forbidden', 403);
      if (url.pathname === '/logout') return reply('', 303, {Location: '/', 'Set-Cookie': `${cookieName}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`});
      if (!/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers.get('Content-Type') || '')) return reply('Unsupported media type', 415);
      const now = Date.now(), ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
      const previous = attempts.get(ip);
      if (previous?.count >= 10) return reply('Слишком много попыток. Попробуй через 10 минут.', 429, {'Retry-After': String(Math.ceil((previous.until - now) / 1000))});
      let body;
      try { body = await readBody(request); } catch { return reply('Request too large', 413); }
      const password = new URLSearchParams(body).get('password') || '';
      if (!await same(password, env.SITE_PASSWORD)) {
        if (attempts.size >= 10000 && !attempts.has(ip)) attempts.delete(attempts.keys().next().value);
        attempts.set(ip, {count: (previous?.count || 0) + 1, until: previous?.until || now + 600000});
        return login('Пароль не подошёл. Попробуй ещё раз.', 401);
      }
      attempts.delete(ip);
      const payload = `${Math.floor(now / 1000) + lifetime}.${hex(crypto.getRandomValues(new Uint8Array(16)))}`;
      const token = payload + '.' + await sign(payload, env);
      return reply('', 303, {Location: '/', 'Set-Cookie': `${cookieName}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${lifetime}`});
    }
    if (!['GET', 'HEAD'].includes(request.method)) return reply('Method not allowed', 405, {Allow: 'GET, HEAD'});
    if (!await authenticated(request, env)) return login('', 200, head);
    if (!['/', '/index.html'].includes(url.pathname)) return reply('Not found', 404, {}, head);
    return reply(page, 200, {'Content-Type': 'text/html; charset=utf-8'}, head);
  },
};
