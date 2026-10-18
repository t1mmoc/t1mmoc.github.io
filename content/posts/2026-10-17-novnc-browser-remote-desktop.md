---
title: "【AIGC】在外想连家里的电脑？但是又完全不想下载应用？那就看看这个novnc"
date: 2026-10-17T16:30:00+08:00
lastmod: 2026-10-17T16:30:00+08:00
draft: false
tags: ["noVNC", "VNC", "远程桌面", "websockify", "内网穿透", "折腾记录", "AIGC"]
categories: ["折腾记录"]
description: "在外面想连家里的 Windows，但别人的电脑不让装软件、手机也不想为这事多装一个 App。noVNC 把 VNC 客户端做成一个网页，配上 websockify 把裸 TCP 翻译成 WebSocket，浏览器打开一个 URL 就是桌面。附我实际在跑的隐藏窗口守护 bat、--file-only 这个容易看错名字的参数、以及 VNC 密码只能算 8 位这件事。"
---

## 起因：一台不让装软件的电脑

场景很具体：人不在家，需要摸一下家里那台一直开着的 Windows。

正常解法是装个 VNC 客户端，输 IP、输密码、连上。问题是：

- **别人的电脑不让装东西**。公司机、网吧机、朋友的笔记本，装个 exe 要么没权限，要么心里过不去。
- **手机可以装，但换设备就得再装一遍**。而且为了偶尔看一眼桌面，专门装一个常年后台的 App，权限还得给一堆。
- **有的环境只给你一个浏览器**。就这样。

那浏览器能不能直接连 VNC？答案是"协议上不行，加一层就行"，而这一层早就有人写好了，就是 **noVNC**。

## 为什么浏览器连不上 VNC

VNC 用的协议叫 **RFB**（Remote Framebuffer），设计得非常省：服务端不传画面截图，只传"屏幕上哪个矩形变了、这块矩形的新像素是什么"，客户端解码后自己画。所以它在窄带宽下也能动，这是它活了二十多年的原因。

问题是它对浏览器不友好——它跑在**裸 TCP** 上。而浏览器能拿到的只有两样东西：

| 浏览器有 | 浏览器没有 |
|---|---|
| `WebSocket`（走 HTTP 握手、按帧封装） | 裸 TCP socket |
| `fetch` / `XHR`（请求-响应，不能双向流） | UDP |

没有任何一个浏览器 API 能让你"连上 5900 端口然后收发二进制流"。

于是中间必须站一个翻译：**左边接 WebSocket，右边连本机 TCP，双向转发**。这就是 **websockify**——它最早叫 wsproxy，本来就是 noVNC 项目的一部分，后来才独立成姊妹项目。

三层结构长这样：

| 层 | 跑在哪 | 干什么 |
|---|---|---|
| noVNC（前端） | 浏览器 | 拿到 WebSocket 字节流 → 解 RFB → 画到 canvas |
| websockify（桥） | 家里那台机器的某个端口 | WebSocket ↔ TCP，顺手还能当静态文件服务器 |
| VNC Server | 127.0.0.1:5900 | 抓屏、算差异、发矩形 |

用户视角只有一条：**打开一个网址，输密码，看到桌面。** 中间三层他都不知道。

## 装：一半是静态文件，一半是个 pip 包

noVNC 的二进制性几乎为零——它就是一堆 HTML + JS。release 包解开就能用，不需要 node、不需要构建。目录里那些 `devDependencies: "latest"` 是给改它源码的人跑 lint 和 karma 测试的，跟你部署没关系。

解压后关键的是这几样：

- `index.html` —— 完整界面的主页面（带设置面板、缩放、剪贴板按钮）
- `vnc_lite.html` —— 单文件精简版，自带样式，只有一条顶栏
- `app/` `core/` `vendor/` —— 主页面依赖的代码、样式、翻译和第三方库

**只有 `vnc_lite.html` 是真正单文件的**，把 `index.html` 单独拷出去是打不开的，别问我怎么知道的。

websockify 那边是 Python 的，一行：

```bash
pip install websockify
```

装完就有了 `websockify` 命令（Windows 上是 `websockify.exe`，落在 Python 的 `Scripts\` 里）。

## 最朴素的一条命令

假设家里那台机器上已经跑着一个监听 `5900` 的 VNC 服务端（TightVNC / UltraVNC / RealVNC / TigerVNC 都行，随便挑），那么：

```bash
websockify 5901 127.0.0.1:5900 --web .
```

拆开看：

- `5901` —— websockify 自己监听的端口，这是**给浏览器用的 WebSocket 端口**，不是 VNC 端口
- `127.0.0.1:5900` —— 真正的 VNC 目标，写 localhost 意味着"只允许本机被代理"（安全上是对的，别改成 0.0.0.0）
- `--web .` —— 顺便把当前目录当静态站点发出去，于是 HTTP 和 WebSocket 走**同一个端口**。省事，防火墙也只开一个。

然后浏览器打开 `http://<这台机器的IP>:5901/index.html`，点 Connect，输 VNC 密码，桌面就出来了。

## 我实际在跑的那个 bat

命令行窗口一关服务就没了，家里那台机器也不会有人天天看着。所以实际用的是个 bat，做三件事：**启动不留黑框、挂了 300 秒自己爬起来、强制 SSL**。

`run.bat`：

```bat
@echo off
cd /D "D:\1\MySelf\novnc"

if "%1" == "h" goto begin
mshta vbscript:createobject("wscript.shell").run("%~nx0 h",0)(window.close)&&exit
:begin

:: need: pip install websockify
websockify.exe 5901 127.0.0.1:5900 --web . --cert=server.pem --file-only --ssl-only

::restart
TIMEOUT /T 300 /NOBREAK
goto begin
```

`stop.bat`：

```bat
@echo off
taskkill /f /im websockify.exe
taskkill /f /im cmd.exe
pause
```

逐条说：

- `if "%1" == "h"` 这段是**自我重启**。双击时不带参数，走第二行 `mshta`，用 VBScript 把自己以 `run(..., 0)` 启动——那个 `0` 就是"窗口不显示"。启动完立刻 `exit`，于是你看到的黑框自己关了，真正干活的进程在后台。带 `h` 参数再进来时跳到 `:begin`，不再递归。
- `cd /D` 切到 noVNC 的目录，因为后面的 `--web .` 是**相对当前工作目录**的。
- `--cert=server.pem` —— 证书。这里没给 `--key`，说明私钥也合并在同一个 pem 里了，Python 的 ssl 支持这种单文件格式。拆成 crt + key 两个文件也行，那就得补 `--key=`。
- `--ssl-only` —— 拒绝非加密连接。不想要 SSL 就别写它，但见下面证书那一节，手机端你会后悔。
- `TIMEOUT /T 300` + `goto begin` —— 最朴素的守护：websockify 退出（崩溃、断网、证书过期加载失败）就等 5 分钟再来。没有服务、没有计划任务、没有 NSSM，5 分钟粒度的自愈。
- `stop.bat` 直接按进程名杀，因为隐藏窗口模式下你根本找不到那个窗口，这是唯一方便的停法。

## `--file-only`：一个特别好骗人的参数名

我一开始以为它是"证书只用这一个文件"。**不是。**

它的真实含义是：**关掉 web 服务器对目录的列表功能**。

差别很大。`--web .` 打开的是一个静态文件服务器，默认访问一个没有 `index.html` 的目录（比如 `/app/`、`/docs/`）时，它会把目录里的文件名全列出来给你点。noVNC 目录里躺着 `server.pem`（含私钥）、`run.bat`、`.gitignore`、`docs/`、`tests/`——这些全在同一个 `--web` 根下。加不加 `--file-only`，决定的是"别人能不能顺手把你私钥下载走"。

所以这个参数不是可选项，是**必须加**。名字起得确实容易误解。

## 证书：为什么最后还是要 wss

一开始我用的是自签证书（`openssl req -new -x509 -days 365 -nodes -out server.pem -keyout server.pem`），本地跑通了，结果一到手机上体验稀烂：地址栏一片红、要连点两次"继续前往"、noVNC 的连接还偶尔直接失败。iOS 那边更麻烦，自签还得手动去"关于本机"里信任描述文件。

换成正经验签的证书之后就安静了。手上正好有个域名在 Let's Encrypt 上续着，把 fullchain 和私钥合并进 `server.pem` 就行：

```bash
cat fullchain.pem privkey.pem > server.pem
```

两件事顺带解决了：

1. **混合内容**。如果哪天你把 noVNC 反代到一个 https 的站点后面，页面是 https、WebSocket 还是 `ws://`，浏览器会直接拦掉，控制台报 mixed content。必须是 `wss://`。
2. **剪贴板**。浏览器的 `navigator.clipboard` 只在安全上下文（https / localhost）下可用。http 页面里 noVNC 的粘贴按钮点了没反应，不是 bug。

顺带提醒：Let's Encrypt 的证书 90 天一续，续完要把新证书合并进 `server.pem` 并重启 websockify。**证书过期那天，一切表现都像服务端挂了**——浏览器连不上、日志没动静、蓝框一直转。

## 用起来是什么感觉

- **手机**：noVNC 支持触屏手势模拟鼠标（单指移动、双指滚轮、长按右键），横屏之后勉强能干点正事。它不是"手机办公"的方案，但"远程点一下某个按钮/看一眼状态"完全够。
- **剪贴板**：支持完整 Unicode 双向复制粘贴，中文不乱码。这点比某些原生客户端还好。
- **缩放**：`Scale` 之后整个桌面塞进视口，小屏幕上不至于要拖动。
- **URL 参数直连**：这是我最常用的一个。noVNC 接受 query string 控制行为：

```text
https://<你的域名>:5901/index.html?autoconnect=1&host=<域名>&port=5901&encrypt=1&password=<VNC密码>
```

  `autoconnect=1` 打开就连，`encrypt=1` 走 wss，`password=` 连密码都带上。存成手机桌面书签，点开就是桌面，一个多余动作都没有。
  （密码写在 URL 里会进历史记录，公用设备上别这么干。自己手机无所谓。）

浏览器版本倒不是问题，官方给的下限是 Chrome 64 / Firefox 79 / Safari 13.4 / Edge 79——都是五六年前的版本了。它被 OpenStack、OpenNebula、ThinLinc 这些正经产品嵌了好多年，稳定性不用怀疑。

## 安全：VNC 密码不是一堵墙

这一节必须单列，因为最容易出事。

**经典 VNC 认证的密码只取前 8 个字符。** 这是协议里的历史包袱（早期用 DES，密钥就 8 字节），不是你设错了。所以 VNC 密码的正确心态是"防手滑"，不是"防人猜"。8 位、无大小写要求、通常还是个纯数字或单词——暴力破解的成本低到可以忽略。

noVNC 本身支持一堆更硬的认证方式（VeNCrypt Plain、RealVNC 的 RSA-AES、UltraVNC 的 MSLogonII、Apple 的 Diffie-Hellman），但这些要求**服务端也支持**。家里随手装的 VNC 服务端大多只给了经典的 VNC 认证。

所以在"密码靠不住"的前提下，边界要靠外面这几层：

| 做法 | 说明 |
|---|---|
| **别把 5901 直接裸在公网** | 最省事的做法是套一层内网穿透，公网只露一个临时端口（我另一篇写的 frp 就是干这个的） |
| 用 `--ssl-only` | 至少别让密码明文飞出去 |
| 反代加一层认证 | nginx/Caddy 在前面挡 Basic Auth 或 OAuth，noVNC 只在内部可达 |
| 安全组放行固定 IP | 出差/公司网络出口固定的话，这条最有效 |
| 别用 5900 当公网端口 | 全网扫描器对 5900/5901 的字典攻击是常态，换随机高位端口能挡掉九成噪音 |

顺带一句：`--web .` 把整个 noVNC 目录都发出去了，这也是为什么上一条的 `--file-only` 不能省。更干净的部署是把要发的文件单独拷到一个 `web/` 目录，根上只留 `index.html`、`vnc_lite.html`、`app/`、`core/`、`vendor/`。

## 踩到的几个坑

**1. `--web .` 是相对路径，`cd` 错了就 404。** 上面那个 bat 里 `cd /D "D:\1\MySelf\novnc"` ——这个目录后来被我搬进了 `2025\` 子目录，bat 里的路径没跟着改。表现是：websockify 起来了，端口也通，但浏览器打开是 404 或者空白页；因为是隐藏窗口模式，你连报错都看不见。这种"服务活着、内容 404"的错，排查起来比进程直接挂掉更烦。改成绝对路径，或者干脆在 bat 里判断一下 `cd` 是否成功。

**2. 5901 不是 VNC 端口。** 它是一个 WebSocket + HTTP 端口。用原生 VNC 客户端去连 `5901` 一定失败，别拿它当"穿透出来的 VNC 端口"用。想两者都要，就再开一个 `5900` 出去（或者走 frp 的 TCP 转发）。

**3. 一个端口干两件事是有前提的。** `--web` 复用端口靠的是 websockify 自己解析 HTTP 请求、区分 WebSocket 升级和普通 GET。中间如果加了一层只认普通 HTTP 的反向代理（比如某些默认配置的 nginx），WebSocket 的 `Upgrade` 头会被吞掉，于是页面能打开、连接一直失败——这时要在代理上加 `proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`。

**4. 端口和防火墙。** `--web` 复用端口意味着只需要开一个端口。但如果前面套了 frp 或者云安全组，记得那条隧道/规则跟着 websockify 的端口走，不是 5900。

## 值不值

这套东西的全部成本：一个解压即用的静态目录，一个 `pip install`，一个十几行的 bat。没有许可费（noVNC 是 MPL 2.0，库部分是 BSD），没有账号，没有设备数限制，跑在自己机器上。

代价是：**它是一个"能用"的方案，不是一个"产品"**。没有会话管理、没有多用户、没有审计日志，画质由 VNC 服务端决定，弱网下会糊。以及那个永远绕不开的前提——里面那层 VNC 密码只算 8 位，真正的门在你自己加的那几层上。

但对"在外面临时摸一下家里电脑"这个需求，它的解法和需求一样朴素：**给个网址，浏览器打开，就是桌面。** 装都不用装，这大概就是它存在的全部意义。
