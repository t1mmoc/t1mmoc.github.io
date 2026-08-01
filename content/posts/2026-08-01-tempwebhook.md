---
title: "【效率工具】家里跑 AI？我写了个温度告警插件，过热就飞书通知我"
date: 2026-08-01T20:30:00+08:00
draft: false
tags: ["效率工具", "TrafficMonitor", "飞书", "温度监控", "C++", "开源"]
categories: ["技术笔记"]
---

家里有台小服务器，平时跑着 AI 助手和一些自动化任务。大部分时间倒也没啥问题，但七八月份的室温一上去，加上编译大项目或者跑模型推理，CPU 和 GPU 温度经常蹭蹭往上涨。

最烦的是——你根本不知道它热了。等你发现的时候，可能已经 90°C+ 跑了几个小时。

## 需求其实很简单

我需要一个东西满足三件事：

1. **安静监控**：开机就在后台跑，别弹窗、别占资源
2. **过热告诉我**：不用我主动去看，CPU/GPU 超阈值了自动通知
3. **别刷屏**：同一次过热只通知一次，冷却期内别重复发

正好我电脑上一直开着 [TrafficMonitor](https://github.com/zhongyang219/TrafficMonitor)（一个轻量的系统监控工具，直接在任务栏显示网速和温度），它提供了插件接口，看了一圈没人做过飞书告警的插件，那就自己写一个。

## TempWebhook：一个 C++ 写的 DLL

插件名叫 **TempWebhook**，本质上是一个 TrafficMonitor 插件 DLL。代码量不大，核心就 800 多行 C++：

- 启动后自动读取 CPU/GPU 温度（TrafficMonitor 每 1 秒把数据传给插件）
- 超过阈值（默认 CPU 95°C / GPU 85°C）且不在冷却期内 → 飞书通知
- 内置 SHA-256 和 HMAC-SHA256（纯 C++ 实现，不依赖 OpenSSL）
- 通过 WinHTTP 发 HTTPS 请求，不走系统代理，避免梯子干扰

```ini
[threshold]
cpu=95                     ; CPU 温度阈值
gpu=85                     ; GPU 温度阈值
cooldown_min=30            ; 冷却时间(分钟)

[webhook]
sign_mode=worker           ; worker = CF 中继 | feishu = 直连
worker_url=                ; 你的 CF Worker URL
secret=                    ; 签名密钥
```

首次运行自动生成带默认值的配置文件，填好 webhook 信息就能用。也支持图形化设置对话框，在插件管理里右键点「选项」就能改。

## 两种通知方案

默认走 **CF Worker 中继模式**，好处是不在本地存飞书机器人 token 和签名密钥——Worker 跑在 Cloudflare 上，本地只发 `GET /?text=...&sign=<secret>` 到 Worker，由 Worker 转发飞书。这样即使有人拿到你的 DLL，也拿不到飞书机器人的密钥。

也可以**直连飞书**，用飞书官方的 HMAC-SHA256 签名方式。两种都支持，`sign_mode` 切一下就行。

全链路延迟：从温度超标到飞书收到通知，通常 < 2 秒。

## 附带一个小工具：温度图表

顺手写了个 Python 脚本 `query_temp.py`，从插件生成的温度历史 JSON 文件里抽取数据，输出摘要统计和 matplotlib 折线图：

```
$ python query_temp.py
{
  "current": {"cpu": 72, "gpu": 53},
  "stats": {
    "cpu_max": 81, "cpu_min": 68, "cpu_avg": 74.5,
    "gpu_max": 55, "gpu_min": 50, "gpu_avg": 52.3
  },
  "count": 30,
  "time_range": {"start": "14:22:10", "end": "14:27:00", "seconds": 290.0}
}
```

`--chart` 参数直接生成暗色主题折线图，适合塞进 Grafana 或者发给队友看。

## 效果

跑了两周，实际上触发过三次告警——全是夏天下午编译大项目时 CPU 飙到 95°C。每次飞书弹出通知，我就去开个风扇或者降点负载。没这东西的话，可能一整个下午 CPU 都在高温线上硬撑。

GitHub 开源（MIT）：https://github.com/t1mmoc/TempWebhook

如果你也在家跑常驻任务，担心散热又不想没事就去点温度监控看看——装上试试，五分钟配完。
