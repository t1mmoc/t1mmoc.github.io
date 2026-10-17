# blog-search Worker

站内语义检索的**查询向量接口**：把用户的搜索词变成与站内文章向量同源的 bge-m3 向量。

- 模型：`@cf/baai/bge-m3`（多语言，1024 维，中文效果好）
- 路由：`https://search.tmoc.qzz.io`（自定义域名，避开 `workers.dev` 在大陆不可达）
- 绑定：仅 `AI`（Workers AI）。**API token 不出边缘**，前端拿不到任何密钥

## 接口

```
POST /embed   {"q": "电脑很卡怎么办"}
  → {"ok":true,"d":"<int8 base64>","s":<量化缩放>,"n":<原始L2范数>,"ms":123}

GET  /health
  → {"ok":true,"model":"@cf/baai/bge-m3","dim":1024}
```

`d` 是 int8 量化的单位向量分量，客户端用 `q_i * s` 还原后与文档向量算余弦。
单次查询 payload ≈ 1.4KB。

## 保护

| 项 | 做法 |
| --- | --- |
| CORS | 白名单 `blog.tmoc.qzz.io` / `t1mmoc.github.io` / `localhost:1313` |
| 限流 | 内存级，120 次/分钟/IP（best-effort，不占 KV 配额） |
| 成本 | Workers AI 免费额度 10k neurons/天 ≈ 900 万 token；一次查询约 30 token |

## 部署

```bash
CLOUDFLARE_ACCOUNT_ID=xxx CLOUDFLARE_API_TOKEN=xxx node scripts/deploy-worker.mjs
```

脚本走 Cloudflare REST API（不依赖 wrangler）：上传模块化 Worker → 绑定自定义域名。

## 相关文件

- 构建期索引：`scripts/gen-vectors.mjs`（读 `public/index.json`，产出 `search-vectors.json`）
- 前端：`layouts/semantic-search.html` + `assets/js/semantic-search.js`
- 参数：`hugo.toml` 的 `[params.semanticSearch]`
