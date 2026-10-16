---
title: "【AIGC】一眼认出假 PoC：一段只会 print 的代码，和一个零代码的 GitHub 仓库"
date: 2026-10-16T19:40:00+08:00
lastmod: 2026-10-16T19:40:00+08:00
draft: false
tags: ["漏洞分析", "PoC", "CVE-2025-31200", "iOS", "信息甄别", "方法论"]
categories: ["技术笔记"]
description: "归档里一条 350 字节的书签顺出来的东西。展品 A 是一段截图里的 CVE-2025-31200「PoC」：函数名叫 simulate、token 前缀 fake_、payload 是 1MB 空字节、所有战果都是 print 出来的，而 target_ip 填的是字符串 \"victim_device_ip\"，第一行 connect 就抛。展品 B 是被到处当成「PoC 已放出」转发的 GitHub 仓库：拉下来只有 2 个 markdown、11,920 字节、零代码，并且它自己写的三个十六进制互相减不出来。附一份能复用的判据清单，以及一个反面参照——同一个作者的另一个仓库里代码是真的，但判定方式是循环论证。"
---

# 起因

归档里翻到一条书签，350 字节，正文就一行自己的话：

> 代码没有实际价值，被抹消了。

下面配了一张 `CVE2025-31200.py` 的截图。

我当时随手记了一句，没细看。这次把它放大逐行读完，发现「没有实际价值」这个评价还是太客气了——**它不是被抹消了价值，它从来就没有过价值**。而且顺着它摸到的那个 GitHub 仓库，比这段代码更能说明问题。

所以这篇讲两件事：这两份东西分别假在哪，以及怎么用三十秒判断一个「PoC」值不值得点开。

---

# 展品 A：一段只会 print 的利用代码

![截图里的 CVE2025-31200.py](/images/fake-poc-tells/fake-poc-cve2025-31200-py.jpg)

把它抄出来读，一共三块。

**第一块，"payload"**：

```python
malicious_audio = b'\x00' * 1024 * 1024
```

1 MB 的**空字节**。真正的音频解码器溢出，畸形之处在于 codec 参数、帧结构、长度字段——需要按目标格式精心构造。一百万个零不是构造物，是占位符。

**第二块，"投递"**：

```python
sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.connect((target_ip, target_port))
sock.send(malicious_audio)
print("[*] Malicious file sent. Triggering buffer overflow ...")
```

两个问题叠在一起。

一是**方向错了**：CVE-2025-31200 是 iMessage 在锁屏状态下自动处理附件时，CoreAudio 解码触发的零点击漏洞。攻击者投递的是**一条消息**，全程不需要在目标机器上开任何端口。这段代码却去 `connect()` 一个 TCP 端口——它假设目标在监听，而目标什么都没在监听。

二是**它连跑都跑不起来**：

```python
target_ip   = "victim_device_ip"
target_port = 12345
```

`"victim_device_ip"` 不是合法地址，`sock.connect()` 在这一行就抛 `gaierror`。**这段代码执行不到它自己吹的那一步。**

**第三块，"战果"**：

```python
def simulate_vulnerability_exploitation():
    print("[*] Exploit triggered. AudioConverterService processing malicious file ...")
    time.sleep(2)
    print("[*] Accessing decrypted push tokens and identity verification tokens ...")
    push_token     = "fake_push_token_12345"
    identity_token = "fake_identity_token_67890"
    print(f"[+] Push Token: {push_token}")
    print(f"[+] Identity Verification Token: {identity_token}")
    print("[*] Manipulating XPC connections to escalate privileges ...")
    time.sleep(1)
    print("[+] Privileges escalated. Access to secure iCloud data granted.")
```

函数名里写着 **`simulate`**。两个 token 的字面量前缀是 **`fake_`**。中间的两个 `time.sleep()` 就是全部"操作"。

所有看起来像成果的行的主语都是 `print`。**没有任何一行代码读取过 token、建立过 XPC 连接、或改变过权限。**

有意思的是它蒙对了一个词：`AudioConverterService` 确实是真漏洞所在的 CoreAudio 组件。而这恰恰是最典型的特征——**它把公告里的名词抄了过来，然后用 print 把公告里的句子重述了一遍。**

---

# 展品 B：一个零代码的"PoC 仓库"

这段代码不是孤例。它被引用的地方是 GitHub 上的 `JGoyd/iOS-Attack-Chain-CVE-2025-31200-CVE-2025-31201`，Telegram 和若干安全媒体在转这条链时都写着「PoC exploit: GitHub」。

把仓库的 tree 拉下来数：

```
blob    5863    Attack Chain Flow.md
blob    6057    README.md
```

**两个文件，11,920 字节，全是 markdown。没有一行代码，没有样本，没有 pcap，没有崩溃转储，没有 IDB，什么都没有。**

一个叫 "PoC exploit" 的仓库，交付物是两份 README。

## 它自己的十六进制互相减不出来

比"没有代码"更能定死性质的，是它给出的具体数字互相矛盾。README 里这句：

> Kernel R/W used to write directly to BCM4387 coexistence SRAM at `0x102000`, which sits **0x5400 bytes below** the IOMMU protection boundary at **`0x1173FF`**.

算一下它自己给的两个地址：

```
0x1173FF - 0x102000 = 0x153FF = 87,039 字节
文中声称的间距        0x5400   = 21,504 字节
误差                  65,535 字节 = 恰好 0xFFFF
```

**误差正好是 0xFFFF。** 这不是抄错一位数——一位数抄错不会恰好差 65,535。这是**有人（或某个模型）需要"看起来精确"，于是填了一个像样的偏移量**，而没有去减那两个它自己都写出来的数。

## 它贴的日志在说另一个解码器

`Attack Chain Flow.md` 声称漏洞在 AMR 解码器：

> AMR 12.2 decoder reads pitch lag without 3GPP TS 26.090 range checks.

然后贴出"观察到的日志"：

```
AudioConverterService ACMP4AACBaseDecoder.cpp: Input format: 2 ch, 44100 Hz, aac
AudioConverterService ACMP4AACBaseDecoder.cpp: inMagicCookie=0x0, inMagicCookieByteSize=39
```

`ACMP4AACBaseDecoder` 是 **AAC** 解码器，`2 ch, 44100 Hz` 是立体声 44.1 kHz。

而 **AMR-NB（12.2 kbps 那一档）固定是 8 kHz 单声道**。它自己的证据在描述另一个解码器。

## 它把两个互斥的说法焊在同一行里

README 第 2 条：

> **Kernel escalation via AppleBCMWLAN/AMPDU handling (CVE-2025-31201)** — RPAC bypass achieves full kernel read/write.

苹果自己的公告里，**CVE-2025-31201 是 RPAC（返回指针认证码）绕过**，属于内存保护措施的问题；而"AppleBCMWLAN/AMPDU 内核提权"是另一套说法（见后面那节）。这一条把两者并成一句，好像它们是同一个机制——**像是同时读到了苹果的措辞和另一篇二手转述，然后把两个都塞了进去。**

---

# 一个必要的对照：同作者的另一个仓库，代码是真的

只骂到这儿不公平。`JGoyd/ZombieHunter` 里确实有代码，我拉下来看了：

```
blob    17567    zombie_detector.py
blob    18886    C4 Binary Analysis/README.md
blob    11004    README.md
blob        1    C4 Binary Analysis/Carved_Binaries/readme
```

`zombie_detector.py` 418 行，`import re / struct / os / tarfile / hashlib`，用 `re.compile` 抽 UUID、用 `struct` 解 sockaddr、遍历 sysdiagnose tar 包。**这是一份真的在做事情的正则/二进制解析工具，不是 print 表演。**

但它的**判定方式是循环的**：

```python
KNOWN_BAD_SHA256S = { ... }   # 作者自己预置的 4 个哈希
FTAB_SYMBOLS   = [...]        # 预置符号表
HID_SYMBOLS    = [...]
GPU_SYMBOLS    = [...]
ANTIFORENSIC_SYMBOLS = [...]
```

而输出那一行是：

```python
f.write(f"\n  IMPLANT SYMBOLS ({len(details['symbol_hits'])} confirmed):\n")
```

**命中作者自己写死的列表，就叫 "confirmed"。** 一个检测器能报出的全部内容，上限就是它被预置的内容——它无法证伪任何东西，包括作者自己的假设。真正的检测工具也带签名库，区别在于每条哈希要标出处（哪个样本、哪次采集、谁验证的），这里的 4 条没有来源。

另外那个 `Carved_Binaries/` 目录里躺着一个 **1 字节**的 readme，本该放被抠出来的二进制的位置是空的。

所以三个东西分三档，别混着骂：

| | 是什么 | 问题 |
|---|---|---|
| B 站那段 `.py` | 表演代码 | 跑不起来，战果全是 print |
| CVE-2025-31200 仓库 | 两份 markdown | 零交付物，且自己的数字互相矛盾 |
| ZombieHunter | 真代码 | 代码没问题，但方法循环论证、样本无出处 |

---

# 判据清单

上面所有结论都能靠这几条机械检查得出来，三十秒内做得完。

## 看代码

1. **标识符里有没有 `simulate` / `mock` / `fake` / `demo` / `pretend`。** 作者自己怎么命名，就是他自己怎么理解这段代码。
2. **字符串字面量有没有 `fake_` / `dummy_` / `test_` 前缀。** `push_token = "fake_push_token_12345"` 不是泄露，是承认。
3. **`time.sleep()` 出现在哪。** 利用链上没有哪一步需要"等两秒然后打印下一条"。sleep 站住的位置，就是真实操作本该在的位置。
4. **把 `print` 全删掉，还剩什么。** 这是最狠的一条测试：如果删掉所有输出语句之后程序不再做任何系统调用、不碰任何文件、不发任何包，那这段代码的"效果"就只存在于文本里。
5. **payload 是构造出来的还是填充出来的。** `b'\x00' * N`、`'A' * 1000`、`os.urandom(N)` 都是占位符。真畸形结构一定带格式字段和边界值。
6. **参数能不能解析。** `target_ip = "victim_device_ip"`、`url = "http://example.com/malware"`、`hash = "abc123..."` ——填不出真值，就说明作者也没跑到过下一步。

## 看仓库

7. **先数文件类型，再读内容。** `git ls-tree -r --long` 或 API 一把就出来。**声称是 PoC 却只有 `.md`，一句话就可以关掉了。**
8. **声称有样本/抓包/转储，就去找对应扩展名。** `.pcap` `.dmp` `.core` `.ips` `.idb` `.macho`。找不到，那些"已验证"就没有支撑。
9. **把它写的十六进制自己减一遍。** 这是最省力的杀手锏：编造者会写出一堆精确的数字，但不会去验算它们之间的关系。间距、偏移、长度、`0x102000`–`0x1173FF` 这种区间，随手一减就露。
10. **看它贴的证据是否描述同一个组件。** 说 AMR 却贴 AAC 的日志、说内核提权却给一个用户态崩溃栈、说堆溢出却给一段栈溢出寄存器——**术语对不上，比术语错更可靠**，因为编造者恰恰会挑听起来对的术语。
11. **看细节的密度和可验证性是否匹配。** 一段话里出现"189 处参数违规""跨 50 帧""210 字节溢出""`0x102000`""VRF#25-01-MPVDT"这么多精确值，却没有任何一个能独立查证——精确本身就是装饰。
12. **看它能不能被证伪。** 判定逻辑是"命中我预置的列表 → confirmed"的，无论跑什么都会确认作者预设的结论。

---

# 真漏洞是什么样

免得这篇只留下"这些都是假的"。按苹果的公告和公开报道：

- **CVE-2025-31200**：CoreAudio 处理特制媒体文件时的内存损坏问题，可导致任意代码执行。由苹果与 **Google 威胁分析小组（TAG）** 共同发现，苹果定性为"可能已用于针对特定个人的极其复杂的攻击"。
- **CVE-2025-31201**：**RPAC（返回指针认证码）** 中的问题，使具备任意读写能力的攻击者可绕过指针认证。由苹果自行发现。
- 两者都在 **iOS 18.4.1（2025-04-16）** 修复，并列入 CISA KEV。

注意苹果口径里 **31201 是 PAC 绕过，不是 Wi-Fi 驱动提权**。而中文圈流传的"AppleBCMWLAN/AMPDU 内核提权"版本，行文本身也带着上面那套特征（精确数字 + 无出处 + 把两个 CVE 的描述互相污染）。**同一个污染源。**

`flow.md` 里那个"恶意 AMR 语音文件，1,606 字节，SHA256 `0de03d7f…`"——我**没能独立验证**这个哈希存在（VT 需要账号）。这本身就是一条：它给了一个可验证形式的标识符，但读者验证不了。

---

# 它是怎么传开的

![B 站评论区](/images/fake-poc-tells/bilibili-comments.png)

2025-05-27 23:52，`輕音Joy` 把这张 `CVE2025-31200.py` 的截图配一条笔记发出来。

第二天 00:12，`XiJet小军` 回了一句「犀利👍」。

07:43，`蚁景网安实验室`——带 LV4 和 UP 认证标的安全教育账号——也来回复并点了个 👍。

**没有任何人要求它跑起来过。**

这就是这类东西的实际传播路径：一段 LLM 生成的、把公告名词重述了一遍的代码，被截图，被配上"CVE-编号 + PoC"的标题，被几个看起来像从业者的账号点赞，然后进了几百个人的收藏夹。它不需要是真的，它只需要**看起来像有人验证过**。

而它唯一一次被要求是真的，是有人把截图存进硬盘、两年后重新打开看。

---

# 收尾

那条书签里我写的是「代码没有实际价值，被抹消了」。

现在改一下：**它没有被抹消过。它从头到尾就是 `time.sleep()` 加 `print()`。** "抹消"这个说法还给了它太多善意——它预设了曾经存在一个真版本，只是被删了。没有。

真正值钱的不是那段代码，是**判断它值不值三十秒的那套动作**：先数文件类型，再减它自己的十六进制，然后看它贴的证据是不是在说同一个组件。这三步都不需要你是漏洞研究员，都不需要跑代码。
