# blog-encrypt 项目记忆

> 下沉自总知识库（cnb.cool/t1mmoc/knowledge）。本仓公开：密钥不入库（WORKER_SECRET、ADMIN_API_TOKEN、GitHub OAuth/PAT 见总知识库；CF 账户见其 cloudflare 条目）。状态：已上线。

## 架构

- 每篇独立密钥 K_article（AES-256-GCM），密文公开存放 static/cipher/<slug>.bin。
- 读者 GitHub 登录；认证 iframe 仅做「认证 + 取 key 回传」，宿主页拿 key 浏览器内解密渲染；admin session 直存 localStorage。
- 入口 https://blog.tmoc.qzz.io（Worker 反代 GitHub Pages + 边缘缓存）；/api + /reader + /health 归 Worker，其余反代 Pages；源站 t1mmoc.github.io 仍可用。
- baseURL 已定源站域名（t1mmoc.github.io），反代域为别名（用户拍板）。

## 双流程

1. Web（用户）：admin 后台 GitHub 登录填 id + 人员 → Worker 生成密钥 JSON（免 token）→ 本地 author.mjs --file x.md --key-json j.json 加密写 static/cipher/<id>.bin。
2. CLI（agent）：author.mjs --file x.md --allow u1,u2 --token $ADMIN_API_TOKEN 自生成密钥并注册 KV。id 默认取文件名；重复鉴别（本地 .bin + KV 同名）exit 2，--force 放行。

渲染用本地 Hugo（--hugo-root 博客根）保证与全站一致，marked 兜底。

## 加密图片 / Git LFS

- 图片 Method A：img2fragment.mjs 把图 base64 内联成 fragment.md，hugo.toml unsafe=true 透传 data:URI；.bin ≈ 原图 ×1.33，图 ≤ 1-2MB。
- Git LFS：.gitattributes 路由 static/cipher/*.bin → LFS；hugo.yml checkout 加 lfs:true（Actions 部署必需）。GitHub LFS 免费 10GiB 存储 + 10GiB 带宽/月，单文件 ≤ 2GiB。

## 端点与会话

- /api/auth/*/api/unlock?article=（x-session 验 ACL + 限流）；/api/admin/*（admin session 或 x-admin-token）；/reader/health。
- session = WORKER_SECRET AES-GCM 密文 {github_id,is_admin,exp}；reader/admin 会话 TTL 30 天，持久化在 iframe origin（blog.tmoc.qzz.io）localStorage，刷新免重登。

## 关键坑

- Worker 经典格式用 body_part 不能 export；route 绑 script 非 script_name。
- 裸 urllib UA 被 CF 1010 拦，需浏览器 UA。
- 解锁框 iframe 背景 transparent + #box 圆角卡片；reportHeight 用 box.getBoundingClientRect（非 scrollHeight，防无限自增）。
- 删除文章只清 KV 密钥，.bin 需手动删。

## 相关位置

- Worker 代码仓库：tdstud1o/blog-encrypt（Worker index.js / frontend/admin.html / tools/author.mjs / tools/img2fragment.mjs）。
- 部署：deploy.py 只读环境变量 / CF secret。

# 背景图（全站二次元随机背景）的既有事实与坑

> 2026-10-17 摸底（GitHub issue #19「手机博客需要来点竖图」，用户澄清：竖图指**背景**）。
> 口径已拍板并实现（分支 `auto/bg-orientation-*` → PR），讨论档案在 issue #19 评论区。

## 现状结构

- 全部逻辑在 `layouts/_partials/extend_footer.html` 的一个 IIFE 里，**没有独立 js 文件**。
- 图池 = 38 个 uapis.cn 静态直链，**全是 `assets/acg/pc/` 横图**（1920×1080 / 2048×1152）。
- 缓存键：`tmoc_bg_url` + `tmoc_bg_ts`（localStorage，TTL 24h）；切页复用同一张，不请求 API。
- 手动切换：`.bg-switch` 按钮，每天 12 次 + 2.5s 冷却。
- CSS：`body::before` + `background-size: cover`，`--site-bg-url` 由 JS 注入。

## 坑（实测）

- **`/api/v1/random/image` 带 `cache-control: no-store`，每次跳不同图**（`?category=acg&type=mb` → 302 到
  `/assets/acg/mb/xxx.jpg`，静态图是 `max-age=604800`）。所以**池里只能放 302 落点，不能放 API URL** ——
  放 API URL 会让「换背景」当天切不回去（localStorage 里存的 URL 每次都变一张）。
- 分类与取向：`type=mb` 抽样 20/20 全是竖图（512×768 ~ 3072×5397，单张 80–590 KB）；
  `type=pc` 是横图。取向由 API 侧保证，前端不必自己判断图片宽高。
- **`a15b4afegy1fmvjn0z1laj21hc0u0k0x.jpg` 是 gzip 过的 JPEG**（`content-type: image/jpeg` +
  `content-encoding: gzip`，326 KB）：浏览器会解，但服务端错配，已从池中剔除。
- 取图源没有「宽高比参数」，只有 pc/mb 两个子类 —— 「响应式取近似取向」只能靠这两个池，不能指望精确比例。

## 现行形态（2026-10-17 改）

- 池拆两个：`POOL_L`（acg/pc 横图，37 张）、`POOL_P`（acg/mb 竖图，16 张；17 张实测竖图剔掉 3072×5397/1MB 那张过大的）。
  原来那两张混在横图池里的 mb 已挪进竖图池，gzip 错配的 `...k0x.jpg` 已删。
- 取向 = `pickPool()`：`innerHeight >= innerWidth` 取竖图池，否则横图池。**只在取新图那一刻判定**，
  不注册 resize / orientationchange。
- **缓存优先但不锁取向**（用户口径）：「缓存是横图，缓存失效的时候下一次根据尺寸近似取向，不是一直横图」。
  `currentCached()` 只验 TTL（24h）与「是否池内 URL」；过期后 `init()` 走 `pick(pickPool(), null)` 按当前视口重抽。
  即：有效期内横图在竖屏也照用满 24h，不强制换向。
- 手动换背景 `change()` 从当前取向池里抽新图（排除当前那张），消耗每日 12 次配额。

# 背景图 v2（2026-10-17 上线）：真随机 + 双缓冲

> 上面「现行形态」那节的两个池从**主图源**降级为**内置兜底**；其余口径（24h 固定、12 次/天、
> 2.5s 冷却、取向只在取新图那一刻判定、不监听 resize）全部保留。

## 结构（三层，自动降级）

1. `GET https://blogbg.tmoc.qzz.io/?type=pc|mb` → 服务端跟随 302 拿**静态落点**返回 JSON。源码 `worker/bg/`。
2. `static/bg-pool.json` — 离线采集清单（竖 589 / 横 579，均验过 200、按实测宽高分桶、单张 ≤2MB）。
3. 模板里的 `POOL_L`(35) / `POOL_P`(17) 内置直链。

客户端（`layouts/_partials/extend_footer.html` 那个 IIFE，仍无独立 js 文件）：

- 双缓冲：`tmoc_bg_next` 存**后台预取并 preload 验真**的那张。换图/到期先立刻用它（零延迟），
  再 `ensureNext()` 后台补一张；`tmoc_bg_seen` 是长度 40 的近期已用环，避免短期撞图。
- `tmoc_bg_api_fail` 记失败时间，**6 小时冷却**内完全不问端点，直接用清单。
- 预取那张日后若 404（清单腐烂），`healIfDead()` 仍先用它保零延迟、后台验一次、真死了再换回清单里的一张。
- 清单走 `XMLHttpRequest` + 1.2s 超时；等不到就用内置池，不空屏。

## 这一轮踩到的硬事实（别再重新发现）

- **alcy 的静态落点约 75% 不发 ACAO**（302 那一跳发，落点 20 次里 15 次不发）→ 浏览器 `fetch` 拿不到落点，
  必须服务端参与。uapis 全链路不发 ACAO，且 `HEAD` 返 405、突发 20 并发触发 429（限流 4 req/s）。
- **uapis 竖图总量实测只有 ~50 张量级**（30 抽 22 唯一、18 抽 12 唯一）。竖图池只能靠 alcy
  （`/mp` 实测 ~1500+、`/pc` ~1000+）。
- **CF 路由：同一 host 上加更精确的 zone route 不会赢过 `blog.tmoc.qzz.io/*`**。实测建了 `.../api/bg`
  精确路由，请求仍由 blog-encrypt 返回 not_found。要加端点就另起子域名。
- **通配证书只到一层**：`bg.blog.tmoc.qzz.io` TLS 直接握手失败（`SEC_E_ILLEGAL_MESSAGE`）；
  `*.tmoc.qzz.io` 只覆盖单层标签。
- **本 CF token 权限不全**：`POST /workers/domains` 报 10405，`/ssl/advanced` 与
  `/accounts/:id/ssl/availability` 报 7003。所以走「橙云 A 记录 + zone 路由」，不是 custom domain。
- ⚠ **`blog-encrypt` 不能从本机重新部署**：上传时 `metadata` 是必填，而 metadata 不带 `bindings`
  会**直接清空全部绑定**（临时 Worker 实测：重传后 `PROBE_VAR` 消失）；它那三个 secret 的值不可读、
  知识库里也没有；不传 `GH_CLIENT_SECRET` 还会把 Worker 打回 DEV 模式。动它之前必须先解决这三件事。
- 只读图片前 4096 字节会**漏掉尺寸**：pixiv 源 JPEG 的 EXIF/XMP 能把 SOF 挤到第 8450 字节（实测），
  同批横图 SOF 在 158 字节所以看起来正常。要么读 64KB，要么按路径分桶。

## 维护动作

```bash
node scripts/bg-pool-harvest.mjs   # 重采落点 -> tmp/bg-pool/pool.json（alcy 4/s，uapis 1/1.4s 避 429）
node scripts/bg-pool-build.mjs     # pool.json -> static/bg-pool.json（按实测宽高分桶、滤 >2MB）
```
