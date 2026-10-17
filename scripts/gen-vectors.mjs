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

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODEL = '@cf/baai/bge-m3';
const DIM = 1024;
const CONTENT_CHARS = 1500; // 每篇正文截断长度
const BATCH = 6; // 每批文档数（每篇 2 条文本；bge-m3 单请求上限 6 万 token）

const args = process.argv.slice(2);
const outArg = args.find((a) => a.startsWith('--out='))?.split('=')[1]
  || (args.includes('--out') ? args[args.indexOf('--out') + 1] : null);
const OUT = path.resolve(ROOT, outArg || 'static/search-vectors.json');
const INDEX = path.resolve(ROOT, 'public/index.json');

const warn = (...m) => console.warn('[gen-vectors]', ...m);

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

async function embed(texts) {
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
    throw new Error(`${res.status} ${JSON.stringify(body.errors || body).slice(0, 300)}`);
  }
  const data = body.result?.data;
  if (!Array.isArray(data) || data.length !== texts.length) throw new Error('返回向量数量不匹配');
  return data;
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
  // 软降级：构建不应因向量生成失败而中断
  warn('向量生成失败，跳过（语义检索自动禁用）:', String(err).slice(0, 300));
}
process.exit(0);
