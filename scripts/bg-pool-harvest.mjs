import fs from 'fs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
// 用法：node scripts/bg-pool-harvest.mjs [--out 目录]（默认写 tmp/bg-pool/，不入库）
const OUT = (()=>{ const i=process.argv.indexOf('--out'); if(i>0) return process.argv[i+1]; const d=process.cwd()+'/tmp/bg-pool'; require('fs').mkdirSync(d,{recursive:true}); return d; })();
fs.mkdirSync(OUT,{recursive:true});
const sleep = ms => new Promise(r => setTimeout(r, ms));

function dims(b) {
  const s = (o, l) => b.toString('ascii', o, o + l);
  if (b.length > 26 && s(0, 4) === 'RIFF' && s(8, 4) === 'WEBP') {
    const c = s(12, 4);
    if (c === 'VP8X') return { f: 'webp', w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    if (c === 'VP8 ') return { f: 'webp', w: (b[26] | (b[27] << 8)) & 0x3fff, h: (b[28] | (b[29] << 8)) & 0x3fff };
    if (c === 'VP8L') { const t = (b[22] | (b[23] << 8) | (b[24] << 16) | ((b[25] << 24) >>> 0)) >>> 0; return { f: 'webp', w: (t & 0x3fff) + 1, h: ((t >> 14) & 0x3fff) + 1 }; }
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o < b.length - 9) {
      if (b[o] !== 0xff) { o++; continue; }
      const m = b[o + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { f: 'jpeg', w: b.readUInt16BE(o + 7), h: b.readUInt16BE(o + 5) };
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { o += 2; continue; }
      const len = b.readUInt16BE(o + 2);
      if (len < 2) return { f: 'jpeg-trunc' };
      o += 2 + len;
    }
    return { f: 'jpeg-trunc' };
  }
  if (b.length > 24 && b[0] === 0x89 && s(12, 4) === 'IHDR') return { f: 'png', w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  return { f: 'unknown' };
}

// 现有 POOL，用于标注清单里哪些是老图
const footer = fs.readFileSync(process.cwd() + '/layouts/_partials/extend_footer.html', 'utf8');
const oldPool = new Set((footer.match(/https:\/\/uapis\.cn\/assets\/acg\/[a-z]+\/[^"]+/g) || []));

async function drawUrl(api) {
  const sep = api.includes('?') ? '&' : '?';
  const r = await fetch(api + sep + '_h=' + Date.now() + '_' + Math.random().toString(36).slice(2, 7), {
    redirect: 'follow', headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000),
  });
  return r.url;
}

async function validate(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA, range: 'bytes=0-4095' }, signal: AbortSignal.timeout(20000) });
  // 不信任 Range：最多读 4096 字节就掐断，防止整张图落进内存/带宽
  const chunks = [];
  let got = 0;
  const reader = r.body && r.body.getReader();
  if (reader) {
    while (got < 4096) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); got += value.length;
    }
    await reader.cancel().catch(() => {});
  }
  const buf = Buffer.concat(chunks.map(c => Buffer.from(c)));
  const cr = r.headers.get('content-range') || '';
  const total = +(cr.split('/').pop() || 0) || null;
  return { status: r.status, total, d: dims(buf), ctype: r.headers.get('content-type') };
}

async function harvest({ label, api, want, rateMs, conc }) {
  const got = new Map();
  const bad = [];
  let draws = 0, t0 = Date.now();
  while (got.size < want && draws < want * 8) {
    const batch = await Promise.all(Array.from({ length: conc }, async () => {
      try {
        const u = await drawUrl(api);
        const v = await validate(u);
        return { u, v };
      } catch (e) { return { err: String(e).slice(0, 60) }; }
    }));
    for (const b of batch) {
      draws++;
      if (!b.u || b.v.status >= 400 || !b.v.d.w) { bad.push(b.u || b.err); continue; }
      if (!got.has(b.u)) got.set(b.u, { url: b.u, label, f: b.v.d.f, w: b.v.d.w, h: b.v.d.h, kb: b.v.total ? Math.round(b.v.total / 1024) : null, old: oldPool.has(b.u) });
    }
    if (draws % 100 < conc) console.log(`  [${label}] 抽${draws} 唯一可用=${got.size} 坏=${bad.length} 用时=${Math.round((Date.now() - t0) / 1000)}s`);
    await sleep(rateMs);
  }
  return { label, rows: [...got.values()], draws, bad };
}

const JOBS = [
  { label: 'alcy-mp', api: 'https://t.alcy.cc/mp', want: 600, rateMs: 250, conc: 4 },
  { label: 'alcy-pc', api: 'https://t.alcy.cc/pc', want: 400, rateMs: 250, conc: 4 },
  { label: 'uapis-mb', api: 'https://uapis.cn/api/v1/random/image?category=acg&type=mb', want: 46, rateMs: 1400, conc: 1 },
  { label: 'uapis-pc', api: 'https://uapis.cn/api/v1/random/image?category=acg&type=pc', want: 150, rateMs: 1400, conc: 1 },
];

const all = [];
for (const j of JOBS) {
  console.log(`开始 ${j.label} 目标 ${j.want} 张`);
  const r = await harvest(j);
  all.push(...r.rows);
  console.log(`完成 ${j.label}: 抽${r.draws} → 可用${r.rows.length}，坏${r.bad.length}${r.bad.length ? ' [' + r.bad.slice(0, 3).join(' , ') + ']' : ''}`);
  fs.writeFileSync(OUT + '/pool.json', JSON.stringify(all, null, 1));
}

const by = {};
for (const x of all) (by[x.label] ||= []).push(x);
console.log('\n===== 清单汇总 =====');
for (const [k, v] of Object.entries(by)) {
  const p = v.filter(x => x.h > x.w).length, l = v.filter(x => x.w > x.h).length;
  const kb = v.map(x => x.kb).filter(Number.isFinite).sort((a, b) => a - b);
  console.log(`${k.padEnd(9)} 共${String(v.length).padEnd(4)} 竖${p} 横${l} 方${v.length - p - l} | KB中位${kb[kb.length >> 1]} p90=${kb[Math.floor(kb.length * .9)]} 最大${kb[kb.length - 1]} 体积未知${v.length - kb.length} | 与老池重叠${v.filter(x => x.old).length}`);
}
console.log(`合计 ${all.length} 条，已写 ${OUT}/pool.json`);
