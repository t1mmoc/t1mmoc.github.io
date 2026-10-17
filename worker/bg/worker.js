// blog-bg Worker — 博客随机背景的「取落点」端点
// 挂在 blogbg.tmoc.qzz.io/* 这条 zone 路由上（独立主机名，不与 blog-encrypt 的 /* 抢）。
// 为什么不用 blog.tmoc.qzz.io/api/bg：实测 CF 让 blog-encrypt 的 `/*` 赢了
// （2026-10-17 建了更精确的 zone route，三次请求仍由 blog-encrypt 返回 not_found），
// 而重新部署 blog-encrypt 会轮换它那三个不可读的 secret。
// 为什么不用 bg.blog.tmoc.qzz.io：通配证书只到一层（实测 TLS 握手直接失败），
// 而本 token 没有 /ssl/advanced 权限，签不了二层域名。
// 契约：GET https://blogbg.tmoc.qzz.io/?type=pc|mb -> 200 {"url","src","type"} | 502 {"error":"no_source"}
// 为什么需要它：uapis 全链路没有 CORS、alcy 的静态落点约 75% 概率没 CORS，
// 浏览器 fetch 拿不到 302 的落点地址；服务端 fetch 不受跨域限制，能拿到稳定落点。

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const UPSTREAM_TIMEOUT_MS = 3500;

// type -> 上游端点，按顺序尝试（先池子大的）
const SOURCES = {
  pc: [
    { name: 'alcy', url: 'https://t.alcy.cc/pc' },
    { name: 'uapis', url: 'https://uapis.cn/api/v1/random/image?category=acg&type=pc' },
  ],
  mb: [
    { name: 'alcy', url: 'https://t.alcy.cc/mp' },
    { name: 'uapis', url: 'https://uapis.cn/api/v1/random/image?category=acg&type=mb' },
  ],
};

// 落点白名单：只允许这两个站已知的图片路径形状。
// 没有这层，本端点会变成「借 blog.tmoc.qzz.io 探测任意 URL」的跳转器。
const ALLOW = [
  { host: 't.alcy.cc', re: /^\/pic\/(pc|mp|moe|moemp|mk|mkmp)\/[\w.\-%]+\.(webp|jpe?g|png)$/i },
  { host: 'uapis.cn', re: /^\/assets\/acg\/(pc|mb)\/[\w.\-%]+\.(webp|jpe?g|png)$/i },
];

function isAllowedLanding(u) {
  if (u.protocol !== 'https:') return false;
  for (const rule of ALLOW) {
    if (u.hostname === rule.host && rule.re.test(u.pathname)) return true;
  }
  return false;
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    }, headers || {}),
  });
}

async function resolveOne(src) {
  const res = await fetch(src.url, {
    headers: { 'user-agent': UA, referer: 'https://blog.tmoc.qzz.io/' },
    redirect: 'follow',
    cf: { cacheTtl: 0 },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const ct = res.headers.get('content-type') || '';
  if (!/^image\//i.test(ct)) return null;
  let landing;
  try { landing = new URL(res.url); } catch (e) { return null; }
  if (!isAllowedLanding(landing)) return null;
  return { url: landing.href, src: src.name };
}

async function handleBg(request) {
  const url = new URL(request.url);
  if (url.pathname !== '/' && url.pathname !== '/bg' && url.pathname !== '/api/bg') {
    return json({ error: 'not_found' }, 404);
  }
  if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
  const type = (url.searchParams.get('type') || 'pc').toLowerCase();
  const chain = SOURCES[type];
  if (!chain) return json({ error: 'bad_type', allowed: Object.keys(SOURCES) }, 400);

  const tried = [];
  for (const src of chain) {
    try {
      const hit = await resolveOne(src);
      if (hit) return json({ url: hit.url, src: hit.src, type: type });
      tried.push(src.name + ':rejected');
    } catch (e) {
      tried.push(src.name + ':' + String((e && e.name) || e).slice(0, 24));
    }
  }
  return json({ error: 'no_source', tried: tried }, 502);
}

addEventListener('fetch', event => {
  event.respondWith(handleBg(event.request));
});
