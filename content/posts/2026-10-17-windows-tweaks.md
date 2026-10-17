---
title: "【AIGC】桌面上那个「备份的config」：九个我每台 Windows 都要打的补丁"
date: 2026-10-17T23:25:00+08:00
lastmod: 2026-10-17T23:25:00+08:00
draft: false
tags: ["Windows", "注册表", "WebDAV", "折腾记录", "AIGC"]
categories: ["折腾记录"]
description: "桌面上有个文件夹叫「备份的config」，里面是九个从 2023 年攒到现在的 Windows 小调整：Win11 右键改回经典版、家庭版硬开远程桌面（直接往 SAM 里手写一个内置组）、WebDAV 的 50MB 上限和 http 限制、关内存压缩、藏掉侧边栏图库、掐死偷跑流量的传递优化、开 IP 转发、清图标缓存。每个都是十几行的小东西，但重装系统时一个个重新翻太费劲，索性建了个仓库放出来。这篇把每一项的原理、命令和恢复方法讲清楚——包括那个文件名比正文还长的 reg。"
---

我的桌面上有个文件夹，叫「备份的config」。里面躺着一个 18KB 的 `ALLconfig.cfg`、一个快捷方式，和九个小文件。前面两个是个人环境，后面的九个是每台 Windows 机器我都必做的调整——从 2023 年 12 月攒到 2025 年 3 月，每个文件都小到只有几行，但重装系统时一个个重新去搜，太费劲了。

所以这次直接做了两件事：[建了个仓库](https://cnb.cool/t1mmoc/windows-tweaks)把它们放出来，再写这篇讲讲每一项的原理和恢复方法。

| 文件 | 干什么 | 恢复 |
|---|---|---|
| win11右键关闭.txt | Win11 右键菜单改回 Win10 经典版 | 文件内第二条命令 |
| 家庭版远程桌面/ | 家庭版硬开 RDP 远程桌面 | 停用 RDP Wrapper |
| WebClient支持http访问.txt | WebDAV 客户端允许 http | `BasicAuthLevel` 改回 1 |
| 取消webdav文件大小上限.reg | 单文件上限 50MB → 4GB | 值改回 `02faf080` |
| 关闭内存压缩.ps1 | 关闭系统内存压缩 | `Enable-MMAgent -mc` |
| 关闭图库功能.reg | 藏掉侧边栏「图库」 | 删除该 CLSID 项 |
| 禁止DoSvc偷网.bat | 禁用传递优化 | 文件内生效行即恢复 |
| 开启ip转发.reg | 本机当路由转发 IP 包 | 值改回 0 |
| 清理图标缓存.bat | 修复图标错乱 | 无需恢复 |

---

## Win11 右键菜单，改回 Win10

Win11 的右键菜单把「显示更多选项」收了一层，天天用的人等于天天多点一下。网上大部分教程让你装插件，其实一行注册表就够：

```bat
reg.exe add "HKCU\Software\Classes\CLSID\{86ca1aa0-34aa-4e8b-a509-50c905bae2a2}\InprocServer32" /f /ve
```

原理：`{86ca1aa0-...}` 是 Win11 新菜单的 COM 类，你给它建一个**空的** `InprocServer32` 项，资源管理器加载这个类失败，就自动回退到 Win10 经典菜单。恢复 Win11 菜单就是 delete 掉这个项——两条命令都写在文件里。

最值得记住的是最后一句：**不用重启电脑**。

```bat
taskkill /f /im explorer.exe & start explorer.exe
```

## 家庭版远程桌面：往 SAM 里手写一个组

这是九个里最硬核的一个。

Windows 家庭版没有 RDP 服务端。主流方案是 [RDP Wrapper](https://github.com/stascorp/rdpwrap)：不改系统文件，用 ini 描述 `termsrv.dll` 的偏移，把远程桌面服务包装出来。但它还有个坑——**家庭版的 SAM 里根本没有 `Remote Desktop Users` 这个组**，你想按专业版的姿势 `net localgroup "Remote Desktop Users" 用户名 /add`，会直接报「找不到组」。

那份 `Remote Desktop组家庭版新增.reg` 干的就是这个：直接往 `HKLM\SAM\SAM\Domains\Builtin\Aliases` 手工写一条别名。RID 用的是 `0x22B`（十进制 555）——正是专业版里 `Remote Desktop Users` 的内置 RID；reg 里那一大坨 hex 是这个组的成员表和安全描述符，描述符里的英文注释原样写着 "granted the right to logon remotely"。写完之后，组就有了，`net localgroup` 那条命令就能用了。

配套的步骤记录在文件夹的 txt 里：下载 RDP Wrapper → 替换 dll（如果不可用）→ 导入 reg → 加用户。

还有一个 `（不需要）家庭版恢复组策略.bat`：用 DISM 把家庭版里被砍掉的 gpedit 组件装回来。文件名前缀就是结论——装了 RDP 之后它不是必须的，留档。

## WebClient 的两个限制

Windows 自带的 WebDAV 客户端（WebClient 服务）出厂自带两道闸，我各留了一个文件。

**第一道：只肯走 https。** `BasicAuthLevel` 默认是 1，意味着 Basic 认证必须在 SSL 上，连内网 http 的 WebDAV 都直接拒。改成 2 就放行 http：

```bat
net stop webclient && net start webclient
```

代价要清楚：2 意味着明文密码可以跑在 http 上，只建议内网用。

**第二道：单文件 50MB。** `FileSizeLimitInBytes` 默认 `0x02faf080` = 50,000,000 字节，大文件复制到一半必报错。reg 拉到 `0xffffffff`——4,294,967,295 字节，也就是 32 位计数器的天花板，4GB。这不是我抠，是这个值本身就只有 32 位，拉满就到这了。

文件名里那句「恢复方法：值改回02faf080」就是这么来的——文件名即文档。

## 关闭内存压缩

```powershell
Disable-MMAgent -mc      # 关闭
Enable-MMAgent -mc       # 恢复
Get-MMAgent              # 查看当前状态
```

内存压缩是 Win10 以后默认开的：内存吃紧时先把页压缩了再塞，用 CPU 换内存。机器内存充裕、磁盘又快（NVMe + 大页面文件）的话，关掉能省点 CPU；**小内存机器别学我**，老老实实开着。

## 藏掉侧边栏的「图库」

Win11 的资源管理器左边栏多了一个「图库」，把截图和相册内容塞在文件树上面，用不上还天天占视线。注册表一行隐藏：

```reg
[HKEY_CURRENT_USER\Software\Classes\CLSID\{e88865ea-0e1c-4e20-9aa6-edcd0212c87c}]
"System.IsPinnedToNameSpaceTree"=dword:00000000
```

恢复方法写在文件名里：删掉 `{e88865ea-...}` 整个项。

## 掐死偷跑流量的 DoSvc

DoSvc 是「传递优化」（Delivery Optimization）：Windows 更新的 P2P 分发系统，会拿你的上行带宽给其他设备传更新块。对流量敏感的机器（热点、按量计费的宽带）这是隐形税。

```bat
:: 禁用（Start=4）
REG add "HKLM\SYSTEM\CurrentControlSet\Services\DoSvc" /v "Start" /t REG_DWORD /d "4" /f
:: 恢复（Start=2，默认自动-延迟）
REG add "HKLM\SYSTEM\CurrentControlSet\Services\DoSvc" /v "Start" /t REG_DWORD /d "2" /f
```

一个诚实的细节：**仓库里这个 bat 当前生效的是恢复那一行**，禁用行被 `::` 注释着。我当初的习惯是禁一段时间就恢复、把禁用命令注释在文件头备用——所以要禁用的话，把两行注释对调再跑。

## 开启 IP 转发

```reg
[HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters]
"IPEnableRouter"=dword:00000001
```

让本机在多块网卡之间转发 IP 包。软路由、多网段互通、某些 VPN/容器网络场景都要它。恢复：值改回 0。改完**要重启**才生效——这是九个里面唯一一个必须重启的。

## 清图标缓存

图标显示错乱（白板、旧图标、缩略图不刷新）时的老三样：

```bat
taskkill /f /im explorer.exe
attrib -h -s -r "%userprofile%\AppData\Local\IconCache.db"
del /f "%userprofile%\AppData\Local\IconCache.db"
start explorer
```

删的是缓存数据库，不是图标本身，放心跑。

---

## 仓库

**<https://cnb.cool/t1mmoc/windows-tweaks>**

所有 `.reg`/`.bat`/`.ps1` 统一转成了 UTF-8 + CRLF（原始文件混着 regedit 的 UTF-16、GBK 和 UTF-8 三种编码，git 里看 diff 很痛苦）。`.reg` 内容是纯 ASCII，导入不受影响；`.bat` 在 GBK 代码页的 cmd 里中文注释可能显示乱码，不影响执行。`ALLconfig.cfg` 和那个快捷方式是个人环境，没收录。

最后提醒：这些调整每一个都在动系统的底盘，动手前知道自己在改什么、怎么改回来，比直接双击 reg 重要得多——所以每个文件的恢复方法都写在文件名或文件里。
