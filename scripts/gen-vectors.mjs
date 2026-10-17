#!/usr/bin/env node
/**
 * 构建期生成站内文章向量索引（bge-m3 / 1024 维 / int8 量化）
 *
 *   node scripts/gen-vectors.mjs                 # 默认写 static/search-vectors.json（本地 hugo server 用）
 *   node scripts/gen-vectors.mjs --out public/search-vectors.json   # CI 在 hugo build 之后写进产物
 *
 * 输入：public/index.json（PaperMod 的 JSON 输出：title / summary / content(纯文本) / permalink）
 * 输出：每篇文章两组向量 —— 标题向量 td + 正文向量 d，前端取 max(cos标题, cos正文) 打分
 *       （实测 max 方案 P@1 19/20、P@3 20/20，优于只用正文或加权混合）
 * 说明：
 *   - 加密文章的密文正文不在 .Plain 里，天然只索引标题+摘要，符合「加密文仅标题可检索」的边界
 *   - 任何失败都只打印警告并退出 0（软降级），站点照常发布；前端发现索引缺失会自动关掉语义检索
 *
 * 需要环境变量：CLOUDFLARE_ACCOUNT_ID、CLOUDFLARE_API_TOKEN（Workers AI 调用权限）
 */

import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODEL = '@cf/baai/bge-m3';
const DIM = 1024;
const CONTENT_CHARS = 1500; // 每篇正文截断长度
const BATCH = 4; // 每批文档数（每篇 2 条文本；bge-m3 单请求上限 6 万 token）

const args = process.argv.slice(2);
const outArg = args.find((a) => a.startsWith('--out='))?.split('=')[1]
  || (args.includes('--out') ? args[args.indexOf('--out') + 1] : null);
const OUT = path.resolve(ROOT, outArg || 'static/search-vectors.json');
const INDEX = path.resolve(ROOT, 'public/index.json');
// 已有的索引（仓库里提交的种子/上次生成的结果）：内容没变就直接复用，不再调 API
const CACHED = path.resolve(ROOT, 'static/search-vectors.json');

// 用 ::warning:: 让软失败在 GitHub Actions 里以 annotation 形式显式暴露（否则会静默降级）
const warn = (...m) => {
  const line = ['[gen-vectors]', ...m].join(' ');
  console.warn(line);
  if (process.env.GITHUB_ACTIONS) console.log(`::warning::${line.replace(/\n/g, ' ')}`);
};

function b64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

/** 与 worker/worker.js 保持同一套量化：int8 + scale + 原始范数 */
function quantize(vec) {
  let maxAbs = 0;
  let sq = 0;
  for (const v of vec) {
    const a = Math.abs(v);
    if (a > maxAbs) maxAbs = a;
    sq += v * v;
  }
  const scale = maxAbs > 0 ? maxAbs / 127 : 1;
  const out = new Uint8Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    let q = Math.round(vec[i] / scale);
    if (q > 127) q = 127;
    if (q < -127) q = -127;
    out[i] = q & 0xff;
  }
  return { d: b64(out), s: scale, n: Math.sqrt(sq) };
}

const stripTags = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

async function embedOnce(texts) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/run/${MODEL}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: texts }),
    },
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    const detail = JSON.stringify(body.errors || body);
    const err = new Error(`${res.status} ${detail.slice(0, 280)}`);
    err.status = res.status;
    // 日额度耗尽：重试和逐条兜底都没意义，直接放弃本次生成（保留旧索引兜底）
    err.quotaExhausted = /daily free allocation/i.test(detail);
    err.retryable = !err.quotaExhausted && (res.status === 408 || res.status === 429 || res.status >= 500);
    throw err;
  }
  const data = body.result?.data;
  if (!Array.isArray(data) || data.length !== texts.length) throw new Error('返回向量数量不匹配');
  return data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 带退避重试；批次仍失败则退化为逐条请求（单条 token 少，几乎不会再超时） */
async function embed(texts) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await embedOnce(texts);
    } catch (err) {
      lastErr = err;
      if (err.quotaExhausted) throw err;
      if (!err.retryable) break;
      warn(`第 ${attempt} 次请求失败（${String(err.message).slice(0, 80)}），重试…`);
      await sleep(attempt * 1500);
    }
  }
  if (texts.length > 1) {
    warn('整批失败，改为逐条重试');
    const out = [];
    for (const t of texts) out.push(...(await embed([t])));
    return out;
  }
  throw lastErr;
}

async function main() {
  if (!process.env.CLOUDFLARE_ACCOUNT_ID || !process.env.CLOUDFLARE_API_TOKEN) {
    warn('缺少 CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN，跳过向量生成（语义检索将不可用）');
    return;
  }
  if (!existsSync(INDEX)) {
    warn(`找不到 ${path.relative(ROOT, INDEX)}，请先 hugo build；跳过向量生成`);
    return;
  }

  const pages = JSON.parse(await readFile(INDEX, 'utf8'));
  if (!Array.isArray(pages) || pages.length === 0) {
    warn('index.json 为空，跳过');
    return;
  }

  const docs = pages.map((p) => ({
    u: new URL(p.permalink).pathname, // 用路径做键：本地/生产域名不同也能对上
    t: p.title,
    title: stripTags(p.title) || stripTags(p.summary).slice(0, 60),
    body: [p.title, stripTags(p.summary), stripTags(p.content).slice(0, CONTENT_CHARS)]
      .filter(Boolean)
      .join('\n'),
  }));

  // 内容指纹：标题/正文没变就不重建，避免「只改 CSS 也全量烧一遍额度」
  const contentHash = createHash('sha256')
    .update(docs.map((d) => `${d.u}|${d.title}|${d.body}`).join('\n'))
    .digest('hex');

  if (existsSync(CACHED)) {
    try {
      const cached = JSON.parse(await readFile(CACHED, 'utf8'));
      if (cached.contentHash === contentHash && Array.isArray(cached.items) && cached.items.length === docs.length) {
        if (path.resolve(OUT) !== path.resolve(CACHED)) {
          await mkdir(path.dirname(OUT), { recursive: true });
          await copyFile(CACHED, OUT);
        }
        console.log(`[gen-vectors] 正文未变，复用已有索引（${cached.items.length} 篇，未调用 API）`);
        return;
      }
      warn(`索引与当前正文不一致（${cached.items?.length ?? 0}/${docs.length} 篇），重建`);
    } catch (err) {
      warn('旧索引无法解析，重建:', String(err).slice(0, 120));
    }
  }

  const items = [];
  let tokens = 0;
  for (let i = 0; i < docs.length; i += BATCH) {
    const chunk = docs.slice(i, i + BATCH);
    // 标题向量与正文向量一起取（同一批请求，2N 条文本）
    const vectors = await embed(chunk.flatMap((d) => [d.title, d.body]));
    chunk.forEach((doc, j) => {
      const tv = quantize(vectors[j * 2]);
      const bv = quantize(vectors[j * 2 + 1]);
      items.push({ u: doc.u, t: doc.t, d: bv.d, s: bv.s, n: bv.n, td: tv.d, ts: tv.s, tn: tv.n });
      tokens += Math.ceil((doc.title.length + doc.body.length) * 0.9);
    });
    process.stdout.write(`\r[gen-vectors] ${Math.min(i + BATCH, docs.length)}/${docs.length}`);
  }
  process.stdout.write('\n');

  const payload = {
    model: MODEL,
    dim: DIM,
    contentHash,
    generated: new Date().toISOString(),
    count: items.length,
    items,
  };

  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(payload), 'utf8');
  const kb = (JSON.stringify(payload).length / 1024).toFixed(1);
  console.log(`[gen-vectors] 写入 ${path.relative(ROOT, OUT)} — ${items.length} 篇 / ${kb} KB / 约 ${tokens} tokens`);
}

try {
  await main();
} catch (err) {
  // 软降级：构建不应因向量生成失败而中断；hugo 已把 static/ 里的旧索引复制进 public/，语义检索仍可用
  warn('向量生成失败，沿用已有索引兜底（索引缺失的文章只走关键词）:', String(err).slice(0, 300));
}
process.exit(0);
