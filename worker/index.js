// Build replaces this marker with the HTML; no public static asset directory.
const page = __SITE_HTML__;
const baseHeaders = {
  'Cache-Control': 'private, no-store, max-age=0',
  'Vary': 'Authorization',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};
function reply(body, status, extra = {}, head = false) {
  return new Response(head ? null : body, {status, headers: {...baseHeaders, 'Content-Type': 'text/plain; charset=utf-8', ...extra}});
}
async function same(a, b) {
  const encode = new TextEncoder();
  const [x, y] = await Promise.all([a, b].map(v => crypto.subtle.digest('SHA-256', encode.encode(v))));
  const left = new Uint8Array(x), right = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}
export default {
  async fetch(request, env) {
    const head = request.method === 'HEAD';
    // Fail closed when production secrets are absent or accidentally shortened.
    if (!env.SITE_USERNAME || typeof env.SITE_PASSWORD !== 'string' || env.SITE_PASSWORD.length < 20) {
      return reply('Вход временно недоступен.', 503, {}, head);
    }
    let supplied = '';
    const auth = request.headers.get('Authorization') || '';
    if (auth.length <= 2048 && /^Basic /i.test(auth)) {
      try { supplied = atob(auth.slice(6).trim()); } catch {}
    }
    if (!await same(supplied, `${env.SITE_USERNAME}:${env.SITE_PASSWORD}`)) {
      return reply('Этот сайт только для подружек. Для входа нужны логин и пароль.', 401, {
        'WWW-Authenticate': 'Basic realm="Girls Night", charset="UTF-8"',
      }, head);
    }
    if (!['GET', 'HEAD'].includes(request.method)) return reply('Method not allowed', 405, {Allow: 'GET, HEAD'});
    const path = new URL(request.url).pathname;
    if (path !== '/' && path !== '/index.html') return reply('Not found', 404, {}, head);
    return reply(page, 200, {'Content-Type': 'text/html; charset=utf-8'}, head);
  },
};
