+++
date = '2026-07-05T18:45:00+08:00'
draft = false
title = '【AIGC】GitHub Pages 全绿却 404？一次离谱的部署 Debug 实录'
description = 'Actions 全部 Success，站点却一直 404。从 .nojekyll 到 deploy-pages 环境问题，记录这次绕了一大圈的排查过程'
tags = ['GitHub Pages', 'GitHub Actions', 'Hugo', 'Debug', 'AIGC']
+++

上一篇写了搭建博客的三个坑，本以为搞定了。结果发完文章一看——**主页 404，点任何链接也 404**。

更离谱的是：GitHub Actions 全绿，Pages 设置显示 "Your site is live"，但 `curl` 回来永远是 `404 Not Found`。

这篇文章记录后续排查中踩的更多坑。

## 坑 4：缺少 `.nojekyll`

GitHub Pages 默认会用 Jekyll 处理静态文件。Hugo 生成的 `assets/` 目录下有带 hash 的文件名，Jekyll 可能会忽略或错误处理这些文件。

**解法**：在 Hugo 的 `static/` 目录下放一个空的 `.nojekyll` 文件，构建时会自动复制到 `public/` 根目录，告诉 GitHub "别用 Jekyll，直接原样发布"。

```bash
touch static/.nojekyll
```

不加这个文件，轻则样式加载不了，重则整个站点白屏 / 404。

## 坑 5：`deploy-pages` 全绿但站点不存在

这是最坑的一个。用官方推荐的 `actions/deploy-pages@v4` 方案：

```yaml
- uses: actions/upload-pages-artifact@v3
  with:
    path: ./public

- uses: actions/deploy-pages@v4
```

Workflow 日志：
```
build    → success ✅
deploy   → Deploy to GitHub Pages → success ✅
```

Artifact 也上传了（`github-pages` 182 KB），看起来一切正常。

但 `curl -sI https://xxx.github.io/` 永远返回 `404`。

调 Pages API：
```bash
curl https://api.github.com/repos/xxx/xxx.github.io/pages
# {"message": "Not Found", "status": "404"}
```

**根因**：`deploy-pages` 需要 Pages 站点以 "GitHub Actions" 作为 Source **预先激活**。如果之前用过 "Deploy from a branch" 模式，切换到 "GitHub Actions" 后 Pages 环境可能没有正确初始化——Actions 报成功，但实际没有写入目标。

**这种情况的解法**：要么手动在 Settings → Pages 反复切换 Source 触发重新激活，要么直接换方案。

## 坑 6：`pages-build-deployment` 幽灵 Workflow

切换部署方案的过程中，Actions 列表里出现了两类 workflow：

| Workflow 名 | 触发方式 | 说明 |
|-------------|---------|------|
| `Deploy Hugo site to Pages` | push to main | 我自己写的 |
| `pages build and deployment` | 自动触发 | **GitHub 自带的** |

`pages-build-deployment` 是 GitHub 在 Pages Source 设为 "Deploy from a branch" 时自动跑的内置构建。它用 Jekyll 处理你的分支内容——如果你的分支根目录是 Hugo **源码**（没有 `index.html`），这个内置 workflow 会构建失败。

结果就是 Actions 列表里红一片，但其实跟你的自定义部署没关系。

**教训**：看 Actions 失败时先看 workflow 名字，别把 GitHub 内置的 `pages-build-deployment` 当成自己的。

## 坑 7：Source 设置和部署方案不匹配

GitHub Pages 有两种 Source 模式，**必须和你的 Workflow 对应**：

```
┌─────────────────────────────────────────────┐
│  Source: GitHub Actions                     │
│  → 对应 deploy-pages@v4 方案                │
│  → Workflow 直接部署，不走分支              │
├─────────────────────────────────────────────┤
│  Source: Deploy from a branch               │
│  → 对应 gh-pages 分支方案                   │
│  → Workflow 推静态文件到分支，GitHub 发布   │
└─────────────────────────────────────────────┘
```

混用会导致：
- 用 `deploy-pages` 但 Source 选了 branch → 部署成功但 404
- 用 `gh-pages` 分支但 Source 选了 GitHub Actions → 分支没人发布

**这次最终的组合**：

```
Workflow: peaceiris/actions-gh-pages@v4 推到 gh-pages 分支
Pages Source: Deploy from a branch → gh-pages / root
```

## 坑 8：`actions-gh-pages` v3 在新 runner 上有兼容问题

`peaceiris/actions-gh-pages@v3` 在较新的 GitHub Actions runner 上偶尔会出问题（Node.js 20 deprecation warning）。换成 `@v4` 后稳定了：

```yaml
- uses: peaceiris/actions-gh-pages@v4
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    publish_dir: ./public
```

## 最终可用 Workflow

```yaml
name: Deploy Hugo site to Pages

on:
  push:
    branches: ["main"]
  workflow_dispatch:

permissions:
  contents: write

concurrency:
  group: "pages"
  cancel-in-progress: false

jobs:
  build-deploy:
    runs-on: ubuntu-latest
    env:
      HUGO_VERSION: 0.163.3
    steps:
      - uses: actions/checkout@v4
        with:
          submodules: recursive
          fetch-depth: 0

      - uses: peaceiris/actions-hugo@v3
        with:
          hugo-version: ${{ env.HUGO_VERSION }}
          extended: true

      - run: hugo --minify

      - uses: peaceiris/actions-gh-pages@v4
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          publish_dir: ./public
```

Pages 设置：`Source → Deploy from a branch → gh-pages → / (root)`

## 排查思路总结

遇到 Pages 404 时按这个顺序排查：

1. **看 Pages API**：`curl https://api.github.com/repos/{owner}/{repo}/pages`，返回 404 说明 Pages 站点根本没激活
2. **看 Source 设置**：和你的部署方案是否匹配
3. **看 Actions 是哪个 workflow 失败**：区分自己的 workflow 和 GitHub 内置的 `pages-build-deployment`
4. **检查 `.nojekyll`**：Hugo 站点必须加
5. **清 CDN 缓存**：部署成功但 404 可能是缓存，加 query param 绕过验证

```bash
# 绕过 CDN 缓存检查真实状态
curl -s "https://xxx.github.io/?nocache=$(date +%s%N)" | grep -o "你的站点名"
```

---

一句话总结：**Actions 全绿 ≠ 站点上线**。GitHub Pages 的部署链路比看起来复杂，Source 设置、环境激活、Jekyll 处理、CDN 缓存，任何一环出问题都会 404。遇到问题别只看 Actions 绿不绿，用 API 和 curl 验证实际状态。
