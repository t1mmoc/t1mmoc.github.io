+++
date = '2026-07-05T16:45:00+08:00'
draft = false
title = '【AIGC】Hugo + PaperMod + GitHub Pages 搭建踩坑全记录'
description = '从零搭建 Hugo 博客到 GitHub Pages，PaperMod v8 配置兼容、部署方案选型等踩坑实录'
tags = ['Hugo', 'PaperMod', 'GitHub Pages', '博客', 'AIGC']
+++

周末想搭个个人博客，选型 Hugo + PaperMod + GitHub Pages。看起来简单的三板斧，实际踩了几个坑，记录一下。

## 坑 1：PaperMod v8 的 TOML 配置变了

`hugo new site` 生成的是空模板，照着网上的 PaperMod 配置教程贴进去，`hugo` 直接报错：

```
unmarshal failed: toml: key homeInfoParams should be a table, not a value
unmarshal failed: toml: expected editPost to be a table, not a value
```

PaperMod 从 v8 开始，`editPost`、`homeInfoParams` 等参数从简单的 key=value 改成了 table 结构：

```toml
# 旧写法（弃用）
homeInfoParams = true
editPost = true
editPostURL = "..."

# 新写法
[params.homeInfoParams]
  Title = "..."
  Content = "..."

[params.editPost]
  URL = "..."
  Text = "..."
  appendFilePath = true
```

同样的问题 `profileMode` 也需要写成 `[params.profileMode] enabled = false`，否则模板里 `site.Params.profileMode.enabled` 会报 `can't evaluate field enabled in type bool`。

**教训**：跟上主题的大版本升级，不要直接复制旧博文的配置。

## 坑 2：Hugo 0.158+ 废弃了 `languageCode`

部署时 Hugo 报警告：

```
WARN deprecated: project config key languageCode was deprecated in Hugo v0.158.0
```

用 `locale` 替代即可，功能一致。

## 坑 3：GitHub Pages 部署方案选型

最初用了 `actions/deploy-pages` + `actions/upload-pages-artifact`，Workflow 跑通了、Deploy 也 Success 了，但站点始终 404。

排查了半小时才发现：GitHub Pages 需要**手动选择**部署源。在 `Settings > Pages` 里 Source 默认是 "Deploy from a branch"，而不是 "GitHub Actions"。两种方案的区别：

| 方案 | 优点 | 缺点 |
|------|------|------|
| Actions Deploy | 干净，不污染分支 | **必须在 Pages 设置里手动切 Source** |
| 推到 gh-pages 分支 | 开箱即用，无需改 Pages 设置 | 多一个分支 |

最终改用 `peaceiris/actions-gh-pages`，把构建产物推到 `gh-pages` 分支，Pages Source 选 "Deploy from a branch" → `gh-pages`，一步到位不用纠结。

完整 Workflow：

```yaml
name: Deploy Hugo site to Pages
on:
  push:
    branches: ["main"]
permissions:
  contents: write
jobs:
  build-deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          submodules: recursive
      - uses: peaceiris/actions-hugo@v3
        with:
          hugo-version: '0.163.3'
          extended: true
      - run: hugo --minify
      - uses: peaceiris/actions-gh-pages@v3
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          publish_dir: ./public
```

## 总结

这套方案最终效果：本地写 Markdown → push 到 main → GitHub Actions 自动构建 → 推到 gh-pages → 站点更新。全程不到 1 分钟。

几个避坑要点：
1. 主题 config 优先参考官方 exampleSite 而不是网上的教程
2. Hugo `languageCode` → `locale`
3. GitHub Pages 部署选 `gh-pages` 分支比 Actions Deploy 省心
