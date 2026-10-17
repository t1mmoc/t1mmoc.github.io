// 把采集结果收敛成站内清单：读 pool.json，按实测宽高分横竖桶，过滤大图，写 static/bg-pool.json
// 用法：node scripts/bg-pool-build.mjs [pool.json 路径]
import fs from 'fs';

const src = process.argv[2] || (process.cwd() + '/tmp/bg-pool/pool.json');
const rows = JSON.parse(fs.readFileSync(src, 'utf8'));
const MAX_KB = 2048;

const footer = fs.readFileSync(process.cwd() + '/layouts/_partials/extend_footer.html', 'utf8');
const builtin = footer.match(/https:\/\/uapis\.cn\/assets\/acg\/[a-z]+\/[^"\r\n]+/g) || [];

const ok = x => x.kb && x.kb <= MAX_KB && x.w && x.h;
const portrait = [...new Set(rows.filter(x => ok(x) && x.h > x.w).map(x => x.url))];
const landscape = [...new Set([...rows.filter(x => ok(x) && x.w > x.h).map(x => x.url),
  ...rows.filter(x => ok(x) && x.h === x.w).map(x => x.url),   // 方图当横图用
  ...builtin])];                                                // 内置那批直链保留在横池里

const out = {
  generated: new Date().toISOString().slice(0, 10),
  note: '离线采集的静态落点（t.alcy.cc / uapis.cn），已验 200 与实测取向，单张 <=2MB。清单会随上游素材变动腐烂，配合 scripts/bg-pool-harvest.mjs 补采。',
  mb: portrait,
  pc: landscape,
};
fs.writeFileSync(process.cwd() + '/static/bg-pool.json', JSON.stringify(out));
console.log(`竖 ${out.mb.length} 条 / 横 ${out.pc.length} 条，写入 static/bg-pool.json（${(fs.statSync(process.cwd() + '/static/bg-pool.json').size / 1024).toFixed(1)}KB）`);
