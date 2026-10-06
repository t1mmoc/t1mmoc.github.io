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
