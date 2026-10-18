#!/usr/bin/env node
/**
 * 把 worker/worker.js 部署到 Cloudflare（不依赖 wrangler）
 *
 *   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node scripts/deploy-worker.mjs
 *
 * 做的事：
 *   1) 上传模块化 Worker（绑定 Workers AI）
 *   2) 绑定自定义域名 search.tmoc.qzz.io（避免 workers.dev 在大陆不可达）
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAME = process.env.WORKER_NAME || 'blog-search';
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ZONE = process.env.CF_ZONE_ID || 'ba7ec2ef5e25f97626311f750b7d9ddb';
const HOSTNAME = process.env.WORKER_HOSTNAME || 'search.tmoc.qzz.io';

if (!ACCOUNT || !TOKEN) {
  console.error('缺少 CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN');
  process.exit(1);
}

const API = 'https://api.cloudflare.com/client/v4';
const headers = { Authorization: `Bearer ${TOKEN}` };

async function api(path, init = {}) {
  const res = await fetch(API + path, { ...init, headers: { ...headers, ...(init.headers || {}) } });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  if (!res.ok || body.success === false) {
    throw new Error(`${init.method || 'GET'} ${path} → ${res.status} ${JSON.stringify(body.errors || body).slice(0, 500)}`);
  }
  return body.result;
}

const code = await readFile(path.join(ROOT, 'worker', 'worker.js'), 'utf8');
const metadata = {
  main_module: 'worker.js',
  compatibility_date: '2026-01-01',
  bindings: [{ type: 'ai', name: 'AI' }],
  observability: { enabled: true },
};

const fd = new FormData();
fd.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
fd.set('worker.js', new Blob([code], { type: 'application/javascript+module' }), 'worker.js');

console.log(`上传 Worker: ${NAME}`);
const uploaded = await api(`/accounts/${ACCOUNT}/workers/scripts/${NAME}`, { method: 'PUT', body: fd });
console.log(`  ok, modified=${uploaded.modified_on}`);

console.log(`绑定自定义域名: ${HOSTNAME}`);
const domains = await api(`/accounts/${ACCOUNT}/workers/domains`);
const existing = domains.find((d) => d.hostname === HOSTNAME);
if (existing) {
  console.log(`  已存在 (service=${existing.service})`);
} else {
  await api(`/accounts/${ACCOUNT}/workers/domains`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ environment: 'production', hostname: HOSTNAME, service: NAME, zone_id: ZONE }),
  });
  console.log('  已创建');
}

console.log(`\n完成 → https://${HOSTNAME}/health`);
