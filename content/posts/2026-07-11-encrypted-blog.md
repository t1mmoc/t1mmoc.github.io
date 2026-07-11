---
title: "【AIGC】给 Hugo 博客加一段「GitHub 登录才解密」的私货"
date: 2026-07-11T00:50:00+08:00
lastmod: 2026-07-12T00:04:00+08:00
draft: false
tags: ["Hugo", "Cloudflare Worker", "加密", "GitHub OAuth", "Git LFS", "TOC"]
categories: ["折腾记录"]
---

最近想把博客里某些段落只给指定的人看——比如自己半成型的想法、给协作者的草稿，又不想让明文躺在公开仓库里被搜索引擎一抓一个准。

折腾了一天，搞出一套「静态博客 + 边缘 Worker + GitHub 登录 + 浏览器内 AES 解密」的方案。它不算完美（浏览器内解密注定明文要进 DOM），但在「不托管私密后端」的前提下，已经是我能接受的最小暴露面。下面记一下全过程和踩的坑。

## 设计思路是怎么敲定的

这东西不是一开始就长这样。最初的想法特朴素：博客发 gpg 加密文章，只有拿到私钥的人能看，最好还能在浏览器里直接解密预览、不下载文件。

**第一版：gpg + 浏览器内桥接。** 研究了一圈 openpgp.js，结论是「能跑但劝退」——每次阅读都得把私钥粘贴进页面，私钥在剪贴板里走一遭，泄露风险不友好；而且整条链路（桥接层 + 密钥管理）维护成本也高。Pass。

**第二版：自建 2FA + 每篇一密钥。** 换个思路：每篇文章独立密钥，放边缘 Worker 上，读者输入 2FA 口令后 Worker 下发该文密钥。但往深里想就塌了：
- 账号、会话令牌怎么存？这又是给自己挖的一个大坑；
- 若「一篇一 TOTP」，读者验证器会被文章塞爆；改成「一读者一 TOTP 解锁文章」，流程又变得别扭；
- 即便拆成「注册 / 解锁」两个界面，状态存储仍是绕不开的硬骨头。

**转折点：评论区不是早就用 GitHub 登录了吗？** 博客评论本身就是 GitHub 登录（giscus）。既然读者已经为评论登录过 GitHub，文章解锁为什么不能复用同一套身份？一次登录、全站通行——读者打开加密文章，Worker 校验其 GitHub 身份、命中白名单就返回该文密钥，浏览器本地解密。

剩下的难点是**跨域**：主站、评论区、Worker 是三个不同源，怎么做到「一次登录通行」？重读 giscus 的做法才想通——它用 iframe + postMessage 做身份代理，且**身份不直接暴露给宿主页**（每个用户在宿主页只拿到一个类似 openid 的匿名 id），既避开了 XSS 把令牌泄露给主站，又能长久登录。这套模式正好能搬过来：认证只在 Worker 的 iframe 内完成，主站只拿回「解密用的 key」，拿不到任何登录令牌。

最终要满足的就三条：

1. 文章主体公开写 Markdown，敏感段作为「碎片」单独加密，插到文章任意位置。
2. 密钥不下发到静态站；只有登录、且在校白名单里的人才能拿到。
3. 读者浏览器本地解密渲染，明文不离开自己的标签页（单篇隔离，XSS 破坏半径压到一篇）。

## 架构

| 主体 | 职责 |
| --- | --- |
| Hugo 静态站（GitHub Pages） | 出文章页、持有密文 `.bin`、嵌入解锁 iframe |
| 边缘 Worker | GitHub OAuth 登录、KV 存密钥、按 ACL 发密钥 |
| 读者浏览器 | 拿到 key 后本地 AES-256-GCM 解密渲染 |

加密链路：**碎片 → 本机 Hugo 渲染成与全站一致的 HTML（含代码高亮）→ AES-256-GCM 加密（随机 32 字节 key + 12 字节 iv）→ 密文写 `static/cipher/<id>.bin` 随博客公开；key/iv/acl 注册进 Worker KV。** 读者点「解锁」→ GitHub 登录 → Worker 验身份 + ACL → 回传 key → 父页本地解密。

关键点：加新内容**不用动 Worker 代码**，密钥和密文都是数据，Worker 运行时实时读 KV。

## 部署踩坑实录

**1. GitHub Secret 加密不是 RSA-OAEP**

要把 OAuth 的 Client Secret 写进仓库 Secret。GitHub 的 `/repos/{owner}/{repo}/actions/secrets/public-key` 返回的是 **32 字节 X25519 公钥**，得用对应的 sealed-box 加密密文，而不是常见的 RSA-OAEP。文档没明说，试错一轮才对。

**2. 解锁框的 iframe 不继承父页主题**

跨域 iframe 不会继承父页的 `data-theme`。结果浅色模式下解锁框白底、深色模式下**还是**白底——因为 iframe 自己画了一块不透明底色。

修复：iframe 背景透明，透出父页本就有的毛玻璃；`#box` 只做圆角卡片（圆角 + 轻描边 + 轻阴影 + 半透明表面），**不在 iframe 内再叠 `backdrop-filter`**，否则和父页毛玻璃叠成「双层毛玻璃」，很怪。

**3. 框体无限自增的 bug**

最初 `reportHeight()` 用 `document.documentElement.scrollHeight` 报高。但在 iframe 里这个值的语义是 `max(内容真实高, 视口高)`。父页每轮把高度 `+4`，视口就变高 → `scrollHeight` 跟着返回视口高 → 父页再 `+4` → 无限增长。

改成量 `#box` 自身的 `getBoundingClientRect().height` 加上 body 上下 padding，与 iframe 视口彻底无关，高度锁定为内容真实高度。

**4. 移动端截断**

父页 shortcode 把 iframe 高度写死 `110px`，窄屏文字折行超过高度就截断、还冒出滚动条。改成 shortcode 消费 Worker 回传的 `blog:resize` 消息做动态高度，并监听父页主题切换同步深色。

## 收尾：固化成 skill

整套「新增加密段」流程固化成了一个可复用 skill。以后只四步：

1. 把要加密的段落写成一个碎片 Markdown
2. 跑作者工具（加密 + 注册密钥到 KV）
3. 在文章里插 shortcode：

```html
{{</* unlock article_id="<id>" */>}}
```

4. `git push`，GitHub Pages 重建即生效。

## 安全底线

- 所有服务端密钥（PAT / OAuth Client Secret / Admin Token / Worker Secret）只存在本地文件和平台 Secret，**绝不进仓库明文**。
- 登录态是服务端密钥 AES-GCM 加密的密文，浏览器和 XSS 都解不开、也伪造不出他人身份。
- 浏览器内解密 = 明文必在 DOM，这是固有属性；方案把它限制在单篇 + 短窗口。
- 受保护页建议配 CSP、不挂第三方脚本。

## 后续升级一：密文托管上 Git LFS

密文 `.bin` 是随博客公开发布的二进制。文字类碎片通常几十 KB 还好，但一旦往里塞加密图片、表情包甚至短视频，单文件就能到几 MB 甚至几十 MB。直接进 git 历史，仓库会被二进制撑大，`clone` / CI checkout 越来越慢。

解法：把 `static/cipher/*.bin` 交给 Git LFS。

```gitattributes
# .gitattributes
static/cipher/*.bin filter=lfs diff=lfs merge=lfs -text
```

```yaml
# .github/workflows/hugo.yml（Actions checkout 必须开 lfs）
- uses: actions/checkout@v4
  with:
    lfs: true
```

关键点（都是踩出来的）：

- **LFS 只瘦 git 历史，不碰 Pages 产物。** git 历史里 `.bin` 变成一段几十字节的 pointer 文本；真实字节存在 LFS 存储。Hugo 构建时 `checkout(lfs:true)` 把真实字节拉回，照常 `cp` 进 `public/cipher/`，Pages 服务的依然是真实密文。所以「LFS 不还是进了 git 吗」这个担心是误会——它进的是 LFS 存储，不是 git 对象库。
- **`lfs: true` 是命门。** 只写 `.gitattributes` 不够；如果用分支部署 / checkout 没开 LFS，Actions 拉到的是 pointer 文本，Pages 上线后解密必失败（拿到的是 pointer 不是密文）。用 `actions/checkout@v4` + `lfs: true` 才稳。
- **迁移已有文件要重接。** LFS 只对「改后 `git add`」的文件生效；已提交的非 LFS 文件不会自动接管。要 `git rm --cached <file>` + `git add <file>` 让它重新走 LFS filter。
- **配额（GitHub 官方）**：免费额度 10GiB 存储 + 10GiB 带宽/月，单文件 ≤2GiB。正常博客阅读有 CF 边缘缓存挡回源，基本不耗 LFS 带宽。
- **验证**：上线后 `curl` 一下 `.bin`，确认返回的是真实二进制（首字节不是 `version https://git-lfs` 开头的 pointer 文本）。

## 后续升级二：边缘常驻文章导航

PaperMod 自带 TOC（`<details class="toc">`），但只在正文有 `##`~`######` 标题时才生成。我想做成「大屏固定到屏幕左侧、滚到底也不消失」的常驻目录。

静态实现很简单：

```css
@media (min-width: 1280px) {
  details.toc { position: fixed; top: 7rem; left: 1.5rem; width: 18.5rem; /* … */ }
}
```

但两个坑把我卡了一轮：

**坑 1：`backdrop-filter` 劫持 fixed。** 文章卡片 `.post-single` 上有 `backdrop-filter: blur(14px)`。按 CSS 规范，`filter` / `backdrop-filter` / `transform` / `perspective` 会创建新的包含块（containing block），导致它内部所有 `position: fixed` 子元素都相对**该卡片**定位，而不是视口。结果 TOC 贴着文章卡片左边缘，而不是屏幕左边。
修复：宽屏下用一小段 JS 把 `details.toc` 从 `.post-single` 里**挪到 `<body>`**，脱离包含块；窄屏再还原回去。

**坑 2：硬断点会重叠。** 纯 `@media (min-width:1280px)` 断点和卡片实际位置对不齐，缩窗口时 TOC 和正文会重叠。改成 JS 动态测距：实时算 TOC 右边缘与文章卡片左边缘的间距，**间距 < 2rem 就立刻切回内嵌折叠目录**，留足缓冲，不再出现重叠。

细节打磨：宽 18.5rem、16px 圆角与卡片统一、滚动条做成贴边的极简矩形（去掉胶囊圆角和上下 margin，避免方形滚动条在圆形卡片上露出尖角）。

最终效果：宽屏左侧常驻目录，滚动时纹丝不动；窗口变窄或空间不足时自动塌成内嵌折叠目录——既好看又不挡正文。这篇本身现在就有导航了（右上角 / 左侧，取决于屏宽），可以实地感受。

---

这套东西现在有真实读者在用（就是我自己的私货段），截至目前没翻车。如果你也想给博客加个「只对特定人可见」的段落，思路可以直接抄。
