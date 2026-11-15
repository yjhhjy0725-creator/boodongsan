import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { delta, getSnapshot } from '../lib/ledger.js';
import { render } from '../lib/view.js';

const digest = (value) => createHash('sha256').update(value).digest();
const equal = (a, b) => timingSafeEqual(digest(a), digest(b));
const cookieName = '__Host-radar';
const lifetime = 8 * 60 * 60;
const options = '; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=';

function signer(secret, password) {
  const key = createHmac('sha256', secret).update(password).digest();
  return (value) => createHmac('sha256', key).update(value).digest('base64url');
}

function validSession(cookie, sign) {
  const session = cookie?.split(';').map((item) => item.trim()).find((s) => s.startsWith(cookieName + '='));
  const [expiry, signature, ...extra] = (session?.slice(cookieName.length + 1) ?? '').split('.');
  return Boolean(signature && !extra.length && /^\d{10}$/.test(expiry) &&
    Number(expiry) > Date.now() / 1000 && equal(signature, sign(expiry)));
}

export default async function handler(req, res) {
  const nonce = randomBytes(18).toString('base64');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; frame-src https://urban.seoul.go.kr; base-uri 'none'; form-action 'self'; connect-src 'self'; img-src 'self' data: https://tile.openstreetmap.org; style-src 'nonce-" + nonce + "'; script-src 'nonce-" + nonce + "'");
  const html = (status, mode, message) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(render(nonce, mode, message));
  };
  const json = (status, payload) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
  };
  const redirect = () => { res.statusCode = 303; res.setHeader('Location', '/'); res.end(); };
  const password = process.env.RADAR_SHARE_PASSWORD;
  const secret = process.env.RADAR_SESSION_SECRET;
  if (!password || password.length < 20 || !secret || secret.length < 32) {
    return html(503, 'closed', '관리자가 접근 설정을 완료하면 이용할 수 있습니다.');
  }
  const sign = signer(secret, password);
  const action = new URL(req.url, 'http://localhost').searchParams.get('action');
  const authenticated = validSession(req.headers.cookie, sign);
  if (req.method === 'GET' && !action) return html(200, authenticated ? 'app' : 'login');
  if (req.method !== 'POST') return json(405, { error: '지원하지 않는 요청입니다.' });
  if (req.headers['sec-fetch-site'] === 'cross-site') return json(403, { error: '요청 출처를 확인해 주세요.' });
  if (action === 'login') {
    const body = typeof req.body === 'string' ? Object.fromEntries(new URLSearchParams(req.body)) : req.body;
    const candidate = body?.password;
    if (typeof candidate !== 'string' || candidate.length > 512 || !equal(candidate, password)) {
      return html(401, 'login', '접속 비밀번호를 확인해 주세요.');
    }
    const expires = String(Math.floor(Date.now() / 1000) + lifetime);
    res.setHeader('Set-Cookie', cookieName + '=' + expires + '.' + sign(expires) + options + lifetime);
    return redirect();
  }
  if (!authenticated) return json(401, { error: '로그인이 필요합니다.' });
  if (action === 'logout') {
    res.setHeader('Set-Cookie', cookieName + '=' + options + '0');
    return redirect();
  }
  if (action !== 'sync') return json(404, { error: '요청 경로를 확인해 주세요.' });
  const revisions = req.body?.revisions;
  const projectRevision = req.body?.projectRevision;
  if (!Array.isArray(revisions) || revisions.length > 20000 || !revisions.every((entry) =>
    Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' &&
    entry[0].length <= 512 && typeof entry[1] === 'string' && entry[1].length === 43) ||
    (projectRevision !== undefined && (typeof projectRevision !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(projectRevision)))) {
    return json(400, { error: '동기화 요청 형식이 올바르지 않습니다.' });
  }
  try {
    return json(200, delta(await getSnapshot(req.headers['x-vercel-oidc-token']), revisions, projectRevision));
  } catch {
    return json(503, { error: 'Google Sheets 원장을 읽지 못했습니다. 잠시 후 다시 시도해 주세요.' });
  }
}
