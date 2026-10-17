# blog-bg Worker

随机二次元背景的**取落点**接口：`GET https://blogbg.tmoc.qzz.io/?type=pc|mb` → `{"url","src","type"}`。

## 为什么需要它

前端拿不到随机图的稳定地址：`uapis.cn` 全链路不发 `Access-Control-Allow-Origin`；
`t.alcy.cc` 的 302 那一跳发了，但它 20 次静态落点里 15 次没发 —— 浏览器 `fetch` 约 75% 直接失败。
302 的落点地址在页面脚本里本来也不可读，除非服务端同意跨域读取。服务端 fetch 不受此限制。

## 约束

- 只接受 `type ∈ {pc, mb}`，其它一律 400；只接受 GET。
- 落点必须匹配白名单形状（`t.alcy.cc/pic/{pc,mp}/x.webp`、`uapis.cn/assets/acg/{pc,mb}/x.jpg`）
  且是 `https:`，否则视为失败继续试下一个源。**没有这层，本端点就是替人探测任意 URL 的跳转器。**
- 上游顺序 alcy → uapis；两个都失败返回 502 `{"error":"no_source","tried":[...]}`。
- 响应 `no-store` + `Access-Control-Allow-Origin: *`（`t1mmoc.github.io` 直连入口也要能用）。
- 上游超时 3.5s。客户端侧失败后退 6 小时不再问，直接用本地清单（见 `static/bg-pool.json`）。

## 部署

```bash
npx wrangler deploy        # 在本目录；或复用仓库外脚本走 REST PUT /workers/scripts/blog-bg
```

不要动 `blog.tmoc.qzz.io/*` 那条路由：它属于 `blog-encrypt`（加密解锁 + 反代）。
实测在同一个 host 上加更精确的 zone 路由**不会**赢过它的 `/*`，所以这里另起子域名。
