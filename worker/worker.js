/**
 * blog-search — 博客站内语义检索的查询向量接口
 *
 * 职责单一：把用户 query 变成与站内文章向量同源的 bge-m3 向量。
 * 不存文档向量（文档向量在构建期生成，随静态站发布）。
 *
 * POST /embed  { "q": "用户查询" }
 *   → { ok, d, s, n, ms }   d=int8 向量(base64) s=量化缩放 n=原始 L2 范数
 * GET  /health → { ok, model }
 *
 * 安全：Workers AI token 只存在于边缘（AI binding），永不下发前端；CORS 白名单；
 * 内存级 IP 限流（best-effort，不写 KV，零额外配额）。
 */

const MODEL = '@cf/baai/bge-m3';
const DIM = 1024;

// 允许的前端来源（生产 + 本地调试）
const ALLOWED_ORIGINS = new Set([
  'https://blog.tmoc.qzz.io',
  'https://t1mmoc.github.io',
  'http://localhost:1313',
  'http://127.0.0.1:1313',
  'http://localhost:8080',
]);

const MAX_QUERY_LEN = 200;
const RL_WINDOW_MS = 60_000;
const RL_MAX = 120; // 每 IP 每分钟

/** @type {Map<string, {n:number, t:number}>} */
const rl = new Map();

function corsHeaders(origin) {
  const h = { 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' };
  if (origin && ALLOWED_ORIGINS.has(origin)) h['Access-Control-Allow-Origin'] = origin;
  h['Vary'] = 'Origin';
  return h;
}

function json(body, cors, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors },
  });
}

function rateLimited(ip) {
  const now = Date.now();
  const rec = rl.get(ip);
  if (!rec || now - rec.t > RL_WINDOW_MS) {
    rl.set(ip, { n: 1, t: now });
    if (rl.size > 5000) rl.clear(); // 防止无界增长
    return false;
  }
  rec.n += 1;
  return rec.n > RL_MAX;
}

/** Float32 → 单位化后 int8 量化（保留缩放与原始范数，供客户端还原余弦） */
function quantize(vec) {
  let maxAbs = 0;
  let sq = 0;
  for (let i = 0; i < vec.length; i++) {
    const a = Math.abs(vec[i]);
    if (a > maxAbs) maxAbs = a;
    sq += vec[i] * vec[i];
  }
  const scale = maxAbs > 0 ? maxAbs / 127 : 1;
  const norm = Math.sqrt(sq);
  const out = new Uint8Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    let q = Math.round(vec[i] / scale);
    if (q > 127) q = 127;
    if (q < -127) q = -127;
    out[i] = q & 0xff;
  }
  return { d: b64(out), s: scale, n: norm };
}

function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    if (url.pathname === '/health') {
      return json({ ok: true, model: MODEL, dim: DIM }, cors);
    }

    if (url.pathname !== '/embed') return json({ ok: false, error: 'not_found' }, cors, 404);
    if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, cors, 405);

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (rateLimited(ip)) return json({ ok: false, error: 'rate_limited' }, cors, 429);

    let q = '';
    try {
      const body = await request.json();
      q = String(body?.q ?? '').trim();
    } catch {
      return json({ ok: false, error: 'bad_json' }, cors, 400);
    }
    if (!q) return json({ ok: false, error: 'empty_query' }, cors, 400);
    if (q.length > MAX_QUERY_LEN) q = q.slice(0, MAX_QUERY_LEN);

    const t0 = Date.now();
    try {
      const res = await env.AI.run(MODEL, { text: [q] });
      const vec = res?.data?.[0];
      if (!Array.isArray(vec) || vec.length !== DIM) {
        return json({ ok: false, error: 'bad_embedding' }, cors, 502);
      }
      const { d, s, n } = quantize(vec);
      return json({ ok: true, d, s, n, ms: Date.now() - t0 }, cors);
    } catch (err) {
      return json({ ok: false, error: 'upstream_failed', detail: String(err).slice(0, 200) }, cors, 502);
    }
  },
};
