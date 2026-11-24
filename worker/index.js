import {gameKinds} from './game.js';
import {hex, same, sign} from './credentials.js';
export {GameRoom} from './room.js';

const page = __SITE_HTML__;
const loginPage = __LOGIN_HTML__;
const clientCode = __CLIENT_JS__;
const rulesCode = __RULES_JS__;
const cookieName = '__Host-gn-session';
const lifetime = 7 * 24 * 60 * 60;
const attempts = new Map();
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
function roomId(value) { return /^[a-f0-9]{32}$/.test(value || '') ? value : ''; }
function login(error = '', status = 200, head = false, room = '') {
  return reply(loginPage.replace('__ERROR__', error).replace('__NEXT_ROOM__', roomId(room)), status, {'Content-Type': 'text/html; charset=utf-8'}, head);
}
async function authenticated(request, env) {
  const token = (request.headers.get('Cookie') || '').split(';').map(v => v.trim()).find(v => v.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
  if (!token || token.length > 180) return false;
  const match = /^(\d{10})\.([a-f0-9]{32})\.([a-f0-9]{64})$/.exec(token);
  if (!match) return false;
  const now = Math.floor(Date.now() / 1000), expires = Number(match[1]);
  if (expires <= now || expires > now + lifetime) return false;
  return await same(match[3], await sign(match[1] + '.' + match[2], env)) ? {id: match[2], expires} : false;
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
      const form = new URLSearchParams(body), password = form.get('password') || '', nextRoom = roomId(form.get('room'));
      if (!await same(password, env.SITE_PASSWORD)) {
        if (attempts.size >= 10000 && !attempts.has(ip)) attempts.delete(attempts.keys().next().value);
        attempts.set(ip, {count: (previous?.count || 0) + 1, until: previous?.until || now + 600000});
        return login('Пароль не подошёл. Попробуй ещё раз.', 401, false, nextRoom);
      }
      attempts.delete(ip);
      const payload = `${Math.floor(now / 1000) + lifetime}.${hex(crypto.getRandomValues(new Uint8Array(16)))}`;
      const token = payload + '.' + await sign(payload, env);
      return reply('', 303, {Location: nextRoom ? '/?room=' + nextRoom : '/', 'Set-Cookie': `${cookieName}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${lifetime}`});
    }
    if (url.pathname.startsWith('/api/')) {
      const api = (body, status) => reply(JSON.stringify(body), status, {'Content-Type': 'application/json; charset=utf-8'});
      const identity = await authenticated(request, env);
      if (!identity) return api({error: 'Войди на сайт ещё раз.'}, 401);
      const match = /^\/api\/rooms\/([a-f0-9]{32})\/(join|socket)$/.exec(url.pathname);
      const create = url.pathname === '/api/rooms';
      if (!create && !match) return api({error: 'Not found'}, 404);
      if (request.headers.get('Origin') !== url.origin) return api({error: 'Forbidden'}, 403);
      const socket = match?.[2] === 'socket';
      if (request.method !== (socket ? 'GET' : 'POST')) return api({error: 'Method not allowed'}, 405);
      if (socket && request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return api({error: 'WebSocket required'}, 426);
      if (!env.GAME_ROOMS) return api({error: 'Онлайн-комнаты ещё не подключены. Можно играть на одном устройстве.'}, 503);
      let body;
      if (!socket) {
        if (!/^application\/json(?:;|$)/i.test(request.headers.get('Content-Type') || '')) return api({error: 'Unsupported media type'}, 415);
        try { body = JSON.parse(await readBody(request)); }
        catch { return api({error: 'Некорректный запрос или слишком большой размер.'}, 400); }
        if (create && !gameKinds.includes(body?.game)) return api({error: 'Неизвестная игра.'}, 400);
      }
      const id = create ? hex(crypto.getRandomValues(new Uint8Array(16))) : match[1];
      const internalHeaders = new Headers({'X-Player-Id': identity.id, 'X-Auth-Expires': String(identity.expires), 'X-Auth-Stamp': await sign('room-access', env)});
      if (socket) internalHeaders.set('Upgrade', 'websocket');
      else internalHeaders.set('Content-Type', 'application/json');
      const stub = env.GAME_ROOMS.get(env.GAME_ROOMS.idFromName(id));
      try {
        const response = await stub.fetch(new Request('https://room.internal/' + (create ? 'create' : match[2]), {method: socket ? 'GET' : 'POST', headers: internalHeaders, ...(socket ? {} : {body: JSON.stringify(body)})}));
        if (socket) return response;
        const result = await response.json();
        if (create && response.ok) result.id = id;
        return api(result, response.status);
      } catch { return api({error: 'Комната временно недоступна. Попробуй ещё раз.'}, 503); }
    }
    if (!['GET', 'HEAD'].includes(request.method)) return reply('Method not allowed', 405, {Allow: 'GET, HEAD'});
    if (!await authenticated(request, env)) return login('', 200, head, url.searchParams.get('room'));
    if (url.pathname === '/client.js' || url.pathname === '/rules.js') return reply(url.pathname === '/client.js' ? clientCode : rulesCode, 200, {'Content-Type': 'text/javascript; charset=utf-8'}, head);
    if (!['/', '/index.html'].includes(url.pathname)) return reply('Not found', 404, {}, head);
    return reply(page, 200, {'Content-Type': 'text/html; charset=utf-8'}, head);
  },
};

