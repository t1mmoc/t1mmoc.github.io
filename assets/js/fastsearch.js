// 站内搜索前端：Fuse 关键词（即时） + bge-m3 语义（异步）融合
//
// 本文件是 PaperMod 主题 assets/js/fastsearch.js 的项目级覆盖（同名路径优先级高于主题）：
//   - 主题 head.html 仍按原逻辑打包 fuse + 本文件 → assets/js/search.js，无需改主题
//   - 语义检索的接口地址/超时由 layouts/search.html 写在 #searchbox 的 data-* 上
//   - 关键词结果先出，且永远不受语义影响；语义到达后合并重排；语义异常静默降级
//
// 调试钩子：/search/?semfail=1 强制语义失败，用于验收「降级」

import * as params from '@params';

const resList = document.getElementById('searchResults');
const sInput = document.getElementById('searchInput');
const searchBox = document.getElementById('searchbox');
const statusEl = document.getElementById('searchStatus');

const ENDPOINT = searchBox?.dataset.semanticEndpoint || '';
const TIMEOUT_MS = Number(searchBox?.dataset.semanticTimeout || 3000);

const KW_DEBOUNCE = 120;
const SEM_DEBOUNCE = 220;
const SEM_MIN_LEN = 2;
const SEM_TOP = 8;
const SEM_MIN_COS = 0.36;
const RRF_K = 15;
const W_KW = 1.0;
const W_SEM = 1.15;
const MAX_SHOWN = 12;

const FORCE_FAIL = new URLSearchParams(location.search).has('semfail');

let fuse = null;
let dataIndex = []; // index.json 原始数组（fuse 的 refIndex 指向它）
let titleMap = new Map(); // path → title
let vecByPath = new Map(); // path → { bv,bn(正文), tv,tn(标题) }
let vecLoading = false;

let semReady = false;
let semCooldownUntil = 0;
let semFailStreak = 0;
let inflight = null;
let seq = 0;

let curQuery = '';
let kwHits = []; // [{ key, href, title }] 按关键词相关度
let semHits = []; // [{ key, href, title, cos }] 按余弦降序
let semForQuery = ''; // semHits 对应的 query，用于判断是否过期

let currentElement = null;
let firstResult = null;
let lastResult = null;

const defaultFuseOptions = {
  distance: 100,
  threshold: 0.4,
  ignoreLocation: true,
  keys: ['title', 'permalink', 'summary', 'content'],
};

const buildFuseOptions = () => {
  if (!params.fuseOpts) return defaultFuseOptions;
  return {
    isCaseSensitive: params.fuseOpts.iscasesensitive ?? false,
    includeScore: params.fuseOpts.includescore ?? false,
    includeMatches: params.fuseOpts.includematches ?? false,
    minMatchCharLength: params.fuseOpts.minmatchcharlength ?? 1,
    shouldSort: params.fuseOpts.shouldsort ?? true,
    findAllMatches: params.fuseOpts.findallmatches ?? false,
    keys: params.fuseOpts.keys ?? defaultFuseOptions.keys,
    location: params.fuseOpts.location ?? 0,
    threshold: params.fuseOpts.threshold ?? defaultFuseOptions.threshold,
    distance: params.fuseOpts.distance ?? defaultFuseOptions.distance,
    ignoreLocation: params.fuseOpts.ignorelocation ?? defaultFuseOptions.ignoreLocation,
  };
};

const debounce = (fn, delay) => {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = window.setTimeout(() => fn(...a), delay);
  };
};

/** 统一用路径做键：本地 hugo server 与生产域名不同也能对上向量 */
const pathOf = (url) => {
  try {
    return new URL(url, location.origin).pathname;
  } catch {
    return url;
  }
};

/* ---------------- 向量解码（与 worker / gen-vectors 的 int8 量化对称） ---------------- */

const b64ToBytes = (b) => {
  const bin = atob(b);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
};

const dequantize = (b64, scale) => {
  const bytes = b64ToBytes(b64);
  const v = new Float32Array(bytes.length);
  let sq = 0;
  for (let i = 0; i < bytes.length; i++) {
    const x = ((bytes[i] << 24) >> 24) * scale;
    v[i] = x;
    sq += x * x;
  }
  return { v, n: Math.sqrt(sq) };
};

const cosine = (a, an, b, bn) => {
  if (!an || !bn) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot / (an * bn);
};

/* ---------------- 渲染 ---------------- */

const setStatus = (on) => {
  if (!statusEl) return;
  statusEl.hidden = !on;
};

const makeRow = (title, href) => {
  const li = document.createElement('li');
  const link = document.createElement('a');
  link.className = 'entry-link';
  link.href = href;
  link.setAttribute('aria-label', title);

  li.appendChild(document.createTextNode(title));
  li.appendChild(link);
  return li;
};

const renderRows = (rows) => {
  if (!rows.length) {
    resList.innerHTML = '';
    firstResult = lastResult = currentElement = null;
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const r of rows) fragment.appendChild(makeRow(r.title, r.href));
  resList.innerHTML = '';
  resList.appendChild(fragment);
  firstResult = resList.firstElementChild;
  lastResult = resList.lastElementChild;
};

/** RRF 融合：关键词名次与语义名次各贡献一份，规避两种分数不可比的问题 */
const mergedRows = () => {
  const semValid = semForQuery && semForQuery === curQuery && semHits.length > 0;
  if (!semValid) return kwHits.slice(0, MAX_SHOWN);

  const merged = new Map();
  kwHits.forEach((h, i) => {
    merged.set(h.key, { key: h.key, href: h.href, title: h.title, score: W_KW / (RRF_K + i) });
  });
  semHits.forEach((h, i) => {
    const add = W_SEM / (RRF_K + i);
    const cur = merged.get(h.key);
    if (cur) cur.score += add;
    else merged.set(h.key, { key: h.key, href: h.href, title: h.title, score: add });
  });
  return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, MAX_SHOWN);
};

const paint = () => renderRows(mergedRows());

/* ---------------- 关键词 ---------------- */

const runKeyword = () => {
  if (!fuse) return;
  if (!curQuery) {
    kwHits = [];
    renderRows([]);
    return;
  }
  kwHits = fuse
    .search(curQuery, { limit: 20 })
    .map((r) => dataIndex[r.refIndex])
    .filter(Boolean)
    .map((d) => ({ key: pathOf(d.permalink), href: d.permalink, title: d.title }));
  paint();
};

/* ---------------- 语义 ---------------- */

const titleOf = (path) => titleMap.get(path) || path.split('/').filter(Boolean).pop() || path;

// 同一查询词的向量缓存：退格重打字/来回切换时不再重复请求（省 neurons）
const vecCache = new Map(); // query → { v, n }

const scoreAll = (v, n) => {
  const scored = [];
  for (const [path, vec] of vecByPath) {
    // 取 max(标题余弦, 正文余弦)：标题命中通常比正文更贴合搜索意图
    const cos = Math.max(cosine(v, n, vec.tv, vec.tn), cosine(v, n, vec.bv, vec.bn));
    if (cos >= SEM_MIN_COS) scored.push({ key: path, href: path, title: titleOf(path), cos });
  }
  return scored.sort((a, b) => b.cos - a.cos).slice(0, SEM_TOP);
};

const runSemantic = async () => {
  if (!semReady || !ENDPOINT || curQuery.length < SEM_MIN_LEN) return;
  if (FORCE_FAIL || Date.now() < semCooldownUntil) return;

  const mySeq = ++seq;
  const myQuery = curQuery;

  // 命中缓存 → 不发请求
  const cached = vecCache.get(myQuery);
  if (cached) {
    semHits = scoreAll(cached.v, cached.n);
    semForQuery = myQuery;
    paint();
    setStatus(false);
    return;
  }

  inflight?.abort();
  const ctrl = new AbortController();
  inflight = ctrl;
  // 区分「超时」与「被新请求/清空输入取消」：后者不算失败，不该触发冷却
  let timedOut = false;
  const timer = window.setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, TIMEOUT_MS);

  setStatus(true);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: myQuery }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (!body?.ok || !body.d) throw new Error(body?.error || 'bad_response');

    const { v, n } = dequantize(body.d, body.s);
    vecCache.set(myQuery, { v, n });
    if (vecCache.size > 50) vecCache.delete(vecCache.keys().next().value);

    const scored = scoreAll(v, n);
    if (mySeq !== seq) return; // 期间又发了新请求，丢弃本次结果
    semHits = scored;
    semForQuery = myQuery;
    semFailStreak = 0;
    paint();
  } catch (err) {
    const superseded = err?.name === 'AbortError' && !timedOut; // 被新请求或清空输入取消
    if (mySeq === seq && !superseded) {
      semFailStreak += 1;
      semCooldownUntil = Date.now() + (semFailStreak >= 2 ? 60_000 : 20_000);
      console.warn('[search] 语义检索降级为纯关键词:', String(err).slice(0, 120));
    }
  } finally {
    window.clearTimeout(timer);
    if (mySeq === seq) setStatus(false);
  }
};

const scheduleSemantic = debounce(runSemantic, SEM_DEBOUNCE);

/* ---------------- 输入 ---------------- */

// 中文/日文输入法组合期间不触发检索：否则拼音未上屏就会发请求（拿字母串算向量）
let composing = false;

const performSearch = () => {
  if (composing) return;
  curQuery = sInput.value.trim();
  if (!curQuery) {
    inflight?.abort();
    inflight = null;
    kwHits = [];
    semHits = [];
    semForQuery = '';
    setStatus(false);
    renderRows([]);
    return;
  }
  runKeyword();
  if (semReady) scheduleSemantic();
  else loadVectors(); // 索引还没就绪时兜底拉一次
};

/* ---------------- 初始化 ---------------- */

const loadVectors = async () => {
  if (!ENDPOINT || vecLoading) return;
  vecLoading = true;
  try {
    const res = await fetch('../search-vectors.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (!Array.isArray(body?.items) || !body.items.length) throw new Error('empty index');
    for (const item of body.items) {
      const bv = dequantize(item.d, item.s);
      const tv = item.td ? dequantize(item.td, item.ts) : bv;
      vecByPath.set(item.u, { bv: bv.v, bn: bv.n, tv: tv.v, tn: tv.n });
      if (!titleMap.has(item.u)) titleMap.set(item.u, item.t);
    }
    semReady = true;
    if (curQuery) scheduleSemantic(); // 索引晚到，补一次语义
  } catch (err) {
    console.warn('[search] 语义索引不可用，仅关键词:', String(err).slice(0, 120));
  }
};

const initSearch = async () => {
  if (!sInput || !resList) return;

  sInput.disabled = false; // 布局里已不带 disabled，这里兼容旧版页面
  sInput.focus();

  try {
    const response = await fetch('../index.json');
    if (!response.ok) {
      throw new Error(`Search index load failed: ${response.status}`);
    }

    const data = await response.json();
    if (Array.isArray(data)) {
      dataIndex = data;
      titleMap = new Map(data.map((d) => [pathOf(d.permalink), d.title]));
      fuse = new Fuse(data, buildFuseOptions());
      // 索引晚到：用户已经敲进词了就先补一次关键词搜索
      if (curQuery) runKeyword();
    }
  } catch (error) {
    console.error(error);
  }

  // 空闲时预取向量索引（约 200KB）：不占首屏带宽，首次输入即可直接语义检索
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 800));
  idle(() => loadVectors());
};

/* ---------------- 键盘导航 ---------------- */

const setActiveResult = (element) => {
  document.querySelectorAll('.focus').forEach((item) => item.classList.remove('focus'));

  if (!element) {
    return;
  }

  element.focus();
  element.parentElement?.classList.add('focus');
  currentElement = element;
};

const reset = () => {
  inflight?.abort();
  inflight = null;
  setStatus(false);
  currentElement = null;
  firstResult = null;
  lastResult = null;
  resList.innerHTML = '';
  sInput.value = '';
  curQuery = '';
  kwHits = [];
  semHits = [];
  semForQuery = '';
  sInput.focus();
};

// 脚本是 defer，DOM 已就绪即刻初始化，不等 window.load（背景大图会把 load 拖到几秒后）
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initSearch);
} else {
  initSearch();
}

// 输入去抖：连续打字只在该词停手后检索一次（关键词 120ms / 语义再 220ms）
const debouncedSearch = debounce(performSearch, KW_DEBOUNCE);

sInput?.addEventListener('input', debouncedSearch);

sInput?.addEventListener('compositionstart', () => {
  composing = true;
});
sInput?.addEventListener('compositionend', () => {
  composing = false;
  debouncedSearch();
});

sInput?.addEventListener('search', () => {
  if (!sInput.value) {
    reset();
  }
});

document.addEventListener('keydown', (event) => {
  const { key } = event;
  const active = document.activeElement;
  const isInSearchBox = searchBox?.contains(active);

  if (key === 'Escape') {
    reset();
    return;
  }

  if (!firstResult || !isInSearchBox) {
    return;
  }

  if (key === 'ArrowDown') {
    event.preventDefault();

    if (active === sInput) {
      setActiveResult(firstResult.querySelector('.entry-link'));
    } else if (active?.parentElement !== lastResult) {
      setActiveResult(active?.parentElement?.nextElementSibling?.querySelector('.entry-link'));
    }
  } else if (key === 'ArrowUp') {
    event.preventDefault();

    if (active?.parentElement === firstResult) {
      setActiveResult(sInput);
    } else if (active !== sInput) {
      setActiveResult(active?.parentElement?.previousElementSibling?.querySelector('.entry-link'));
    }
  } else if (key === 'ArrowRight') {
    if (active?.matches?.('.entry-link')) {
      active.click();
    }
  }
});
