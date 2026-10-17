---
title: "【AIGC】因为frp太贵，我自己租了一个服务器弄frpc"
date: 2026-10-17T16:20:00+08:00
lastmod: 2026-10-17T16:20:00+08:00
draft: false
tags: ["frp", "内网穿透", "自建服务", "Linux", "Windows", "systemd", "折腾记录"]
categories: ["折腾记录"]
description: "内网穿透服务商按隧道和带宽收月租，一年下来比一台轻量云服务器还贵。干脆自己租台机器跑 frps，Windows 这端 frpc 用 TOML 配置、bat 隐藏窗口加 300 秒守护重启，把 22 和 noVNC 的 5901 都捅到公网去。附 0.61 版本的配置格式变化、systemd 服务、以及 token 明文和 7500 面板裸奔这两个必须收的尾。"
---

## 起因：算了一笔不该算的账

一开始我用的是现成的内网穿透服务。需求也不大：一台家里的 Windows 机器，想把 SSH 和一个 noVNC 的 VNC 端口捅到公网，偶尔远程摸一下。

然后看价格表：免费档限速限流量，想跑满带宽要月付，多一条隧道加钱，独立域名加钱，TCP 转发比 HTTP 更贵。掐着指头算，一年的钱够买一台入门轻量云服务器，而且这台服务器还能干别的。

frp 本身是开源的，服务端 `frps` 和客户端 `frpc` 都是白送的，收费的只是"别人帮你托管 frps"。那托管这件事有多难？一台 1 核 1G 的小机器，一个 `frps.toml`，一个 systemd 单元文件，加起来不到 20 行配置。

于是就有了这个目录：`frp_0.61.0_linux_amd64` 和 `frp_0.61.0_windows_amd64`，一个放服务器，一个放家里那台 Windows。

## 先看清楚：谁跑在哪

frp 的模型很朴素——**服务端在公网，客户端在内网，客户端主动向服务端建立长连接，把内网端口映射成公网端口**。因为是内网主动往外连，家里不需要公网 IP，不用碰路由器端口映射，也不怕运营商 NAT。

我这里的实际拓扑：

| 角色 | 位置 | 版本包 | 职责 |
|---|---|---|---|
| `frps` | 公网轻量云（Linux） | `frp_0.61.0_linux_amd64` | 监听 7000 收信令，按规则开公网端口 |
| `frpc` | 家里 Windows | `frp_0.61.0_windows_amd64` | 主动连服务端，把本地端口挂上去 |
| Dashboard | 服务端 7500 | 同上 | 看隧道状态、流量统计 |

两个端口是我实际用的：

- **22 → 6000**：把内网 SSH 挂出来（测试用）
- **5901 → 1234**：noVNC 的 VNC 端口，远程看桌面

## 服务端：frps

### 配置文件

frp 从 0.52 起主推 TOML，0.61 这里 `.ini` 已经彻底是老黄历了。网上大量教程还在教你写 `frps.ini`，照抄会因为格式不被识别而直接起不来——**这是自建 frp 最容易踩的第一坑**。

服务器上的 `frps.toml`：

```toml
bindPort = 7000
auth.token = "<REDACTED>"   # 身份验证令牌，frpc 要与 frps 一致

# Server Dashboard，可以查看 frp 服务状态以及统计信息
webServer.addr = "0.0.0.0"
webServer.port = 7500
webServer.user = "Frps"
webServer.password = "<REDACTED>"
```

三个要点：

1. `bindPort` 是**信令端口**，不是业务端口。业务端口是 frpc 那边 `remotePort` 指定的，frps 会在收到注册后动态监听它。
2. `auth.token` 是唯一凭据。它一旦泄漏，任何人都能把你的服务器当跳板开隧道——所以别学我最初那样跟面板密码写成同一个字符串。
3. `webServer` 是管理面板。`0.0.0.0` 意味着公网可达，**这是最危险的一行**，后面第六节专门处理。

### 用 systemd 托管

手动 `./frps -c frps.toml` 一退出终端就没了。生产用法是丢进 `/opt/frps`，交给 systemd：

```ini
[Unit]
Description=Frps service
Wants=network.target
After=network.target network.service

[Service]
Type=simple
WorkingDirectory=/opt/frps
ExecStart=/opt/frps/frps -c frps.toml
KillMode=process

[Install]
WantedBy=multi-user.target
```

装法：

```bash
sudo cp frps /opt/frps/ && sudo cp frps.toml /opt/frps/
sudo cp frps.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now frps
sudo systemctl status frps      # 确认 active (running)
journalctl -u frps -f           # 看隧道注册日志
```

`WorkingDirectory` 那行不能省——`-c frps.toml` 是相对路径，工作目录不对就找不到配置。

### 安全组比配置文件更容易漏

云服务器的**安全组/防火墙**默认只放行 22、80、443。7000 不放行，frpc 会一直卡在 `connect to server error: i/o timeout`，日志看起来像服务端挂了，实际是包在门口就被丢了。

要放行的：

- `7000/tcp` — 信令
- `7500/tcp` — 面板（建议改成只放行自己 IP，或直接不开）
- 每条隧道的 `remotePort` — 我这里是 6000、1234

## 客户端：frpc

### 配置

家里 Windows 的 `frpc.toml`：

```toml
serverAddr = "<你的服务器域名或 IP>"
serverPort = 7000
auth.token = "<与 frps 一致>"

[[proxies]]
name = "novnc"
type = "tcp"
localIP = "127.0.0.1"
localPort = 5901
remotePort = 1234
```

连上之后，访问 `服务器IP:1234` 就等于访问本机的 `127.0.0.1:5901`。noVNC 是纯 TCP 转发的，不需要为 WebSocket 做额外配置——这也是 TCP 类型最好用的地方。

另存了一份本地测试用的配置，挂在 `127.0.0.1` 上把 22 转到 6000，用来验证服务端行为，不上公网：

```toml
serverAddr = "127.0.0.1"
serverPort = 7000

[[proxies]]
name = "test-tcp"
type = "tcp"
localIP = "127.0.0.1"
localPort = 22
remotePort = 6000
```

### 隐藏窗口 + 守护重启

家里那台机器不是天天开着终端。最省事的做法是一个 bat：**启动时不留黑框，进程挂了 300 秒后自己再拉起来**。

`run.bat`：

```bat
@echo off
cd /D "D:\1\MySelf\2025\自建frpc\frp_0.61.0_windows_amd64"

if "%1" == "h" goto begin
mshta vbscript:createobject("wscript.shell").run("%~nx0 h",0)(window.close)&&exit
:begin

frpc.exe -c frpc.toml

::restart
TIMEOUT /T 300 /NOBREAK
goto begin
```

拆开看就三件事：

- `if "%1" == "h"` 判断带没带参数。不带参数时走第二行，用 `mshta` 调 VBScript 把**自己**以隐藏窗口方式重新启动（`run(..., 0)`，0 就是不显示窗口），然后立刻退出。于是你双击时看到的那个黑框自己关掉了，真正干活的 daemon 在后台。
- `goto begin` 之后进入真正的工作区，前台跑 `frpc.exe`。`%1` 为 `h` 时直接跳到这里，不再递归。
- `frpc.exe` 退出（崩溃、断网、被误杀）就 `TIMEOUT /T 300` 等 5 分钟，再 `goto begin` 重来。**这就是一个最朴素的守护进程**——没有服务、没有计划任务，5 分钟粒度的自愈。

`stop.bat` 就一行：

```bat
@echo off
taskkill /f /im frpc.exe
pause
```

因为进程名固定是 `frpc.exe`，杀起来不用找 PID。隐藏窗口模式下这是唯一方便的停法。

## 几个真踩到的坑

**1. ini 和 toml 混着抄。** 0.61 的 TOML 用点号表达嵌套（`webServer.addr`），INI 用 `[common]` 段。混着抄的典型症状是启动就报解析错误，或者更阴的——配置被静默忽略、起来之后行为跟没配一样。判断版本：`./frps -v` 看输出，0.52 以下才该用 ini。

**2. `remotePort` 撞车。** 两个 frpc 客户端都想占同一个公网端口，后连上的那条会注册失败，日志里是 `port already used`。它的表现很像断线：面板上少一条隧道，但客户端进程还活着。多客户端部署时端口表要自己排一遍。

**3. 客户端断线不等于配置错。** 家里网络重启、公网 IP 变化、服务端重启——这些都会让 `frpc` 掉线。`run.bat` 那个 300 秒循环就是为这个写的。真正配置错的时候日志会明确报 `token in login doesn't match` 或 `connect to server error`，两者要分清。

**4. 域名解析。** 客户端里写 `serverAddr` 用域名比 IP 稳，IP 变了不用改客户端——但别把 `serverAddr` 写成 `127.0.0.1`，那是本地测试配置，抄到公网客户端上会连自己。

## 必须收的尾：两个裸奔点

这套配置跑起来就能用，但它是**能跑**，不是**安全**。两处必须动手：

**其一，`auth.token` 和面板密码不能是明文字符串。** 我最初把 `auth.token` 和 `webServer.password` 写成了同一个可猜的值。token 一旦泄漏，别人就能往你的服务器上挂隧道，用你的带宽、拿你的 IP 做任何事。正确做法是随机长串，两套分开：

```bash
openssl rand -base64 32
```

**其二，7500 面板不要裸在公网。** `webServer.addr = "0.0.0.0"` 加上弱密码，等于把隧道拓扑图挂在门口。三个可选动作：

- 把 `addr` 改成 `127.0.0.1`，需要时用 SSH 隧道进去看
- 用安全组只放行自己的固定 IP
- 至少换掉默认用户名、上强密码

另外 `frps.toml` 还支持 `allowPorts`，可以限定只允许注册某些公网端口，避免客户端把整个端口段乱开；`transport.tls.force = true` 可以强制加密信令。这两个都属于"配了不亏"。

## 值不值

现在这套东西的全部成本是：一台一直开着的轻量云服务器（本来就在付），加上十几个字节的配置文件。没有隧道数量限制，没有带宽档位，端口想开几个开几个，TCP/UDP 都行。

代价也很清楚：**运维责任归自己了**。证书、升级、token 轮换、日志、机器本身的安全，都得自己管。以及一次很便宜但很真实的教训——配置里的每一个明文密码，都是一定会有一天需要改的东西。

写这篇文章时我把仓库里那份 `frps.toml` 的 token 和面板密码都打了码。不是因为这篇博客会被谁盯上，而是**凭据进文档、进仓库、进截图，是泄漏最常见的三种方式**，少一种是一种。
