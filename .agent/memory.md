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
