---
title: "【AIGC】自己定一个 TCP 帧协议：魔数、长度前缀、粘包，和一个把我救回来的全局开关"
date: 2026-10-17T17:12:00+08:00
lastmod: 2026-10-17T17:12:00+08:00
draft: false
tags: ["TCP", "协议设计", "粘包", "MINA", "Java", "C++", "折腾记录"]
categories: ["技术笔记"]
description: "2023 年写了个 C/S 的东西，服务端 Java + Apache MINA，客户端 C++ DLL，嫌 HTTP 不合适就自己定了协议：4 字节魔数 + 4 字节长度 + JSON 正文。事后看协议部分才是真正学到东西的地方——TCP 是字节流不是消息流，所以解码器必须变成状态机；状态不能放字段（MINA 的 decoder 是单例），我用了静态 HashMap 代价是泄漏和并发；length 字段在编码侧是字节数、在对象构造里是字符数，ASCII 下看不出来、中文差三倍；还有一个为了让某个会话别卡住而加的 static 全局开关，它会误伤所有会话。"
---

## 起因

2023 年写过一个 C/S 的东西：服务端 Java（Spring Boot 里嵌 Apache MINA），客户端是 C++ 写的 DLL。两边要长期连着、服务端能主动推东西下去。

HTTP 做不到这件事——至少 2023 年的我不会：服务端主动下发就得 WebSocket 或 SSE，而我要的是"一条连接上双向随便发"。所以干脆自己定协议。

代码后来冻结在一个私有仓里，不公开。但协议这一段踩出来的东西是通用的，值得单独写一遍。

## 一、帧长什么样

最后定下来就三样：

```
[ 4 字节魔数 01 70 18 68 ][ 4 字节长度 ][ 长度个字节的 JSON 正文 ]
```

**魔数**的作用只有一个：确认对面说的是同一门语言。字节流里没有类型信息，前四个字节不对就说明要么连错了端口，要么对面是别的协议，要么中间有人在喂垃圾。这一步拦下来的问题，比后面所有校验加起来都多。

**长度前缀**选它是有原因的。TCP 上标定消息边界的办法只有三种：

| 办法 | 做法 | 代价 |
|---|---|---|
| 定长 | 每条消息固定 N 字节 | 消息大小一变就得改协议 |
| 分隔符 | 用 `\n` 或 `\0` 结尾 | 正文里不能出现这个字节，对二进制不安全 |
| **长度前缀** | 头里写清正文多长 | 头必须可信，长度算错就全乱 |

我选第三种，因为它对二进制安全——哪怕正文里全是 `0x00` 也不影响。

**正文用 JSON**，不是紧凑二进制。理由是调试期能直接 `tail -f` 看日志，一眼知道对面发了什么。代价是每次都要序列化 + 长度要另外算 + 校验要单独做。这个取舍在开发期非常划算，在上线后开始变贵。

## 二、粘包这件事，是所有自研协议的入场券

TCP 给你的是**字节流**，不是消息流。一次 `read()` 可能给你 0.3 个包，也可能一次给你 3 个包，取决于内核缓冲、MTU、网络抖动。这不是 bug，是 TCP 的定义。

所以解码器不能写成"读一条消息"，必须写成**状态机**：

```
状态 0：还没看到头
  ├─ remaining < 8   → 存着，等下批数据
  └─ remaining >= 8  → 校验魔数，读出 length，进状态 1
状态 1：等正文
  ├─ remaining < length  → 存着，等下批数据
  └─ remaining >= length → 取出 length 字节，产出一条消息，回状态 0
```

MINA 的 `ProtocolDecoder` 恰好就是这个形状：`decode(session, in, out)` 可以被反复调用，`in` 是累积的缓冲区，你从里面 `get` 多少它就走多少，剩下的留给下一次。所以判据只有一句：

> **别读超过 `in.remaining()` 的东西。**

魔数那段代码是这么写的：

```java
if (in.remaining() >= (4 + Message.magicNumber.length)) {
    byte[] verifyBytes = new byte[Message.magicNumber.length];
    in.get(verifyBytes);
    if (!Arrays.equals(verifyBytes, Message.magicNumber)) {
        log.warn("Message verify failed, wrong message!!{}", verifyBytes);
        in.position(in.limit());   // 丢掉这批，等对面重连
        return;
    }
    message = new Message();
    messageMap.put(session, message);
    message.setLength(in.getInt());
} else {
    return;                        // 头都没凑齐，什么都不做
}
```

注意 `in.get(verifyBytes)` 是**消费**（position 前移），不是 peek。如果校验失败而你没把 position 退回去，后面这一批数据就废了。这也是为什么校验失败后我直接把 position 推到 limit：既然已经不知道边界在哪，这批数据不能再用。

## 三、状态存在哪：一个会话一份

这是踩得最深的一处。

MINA 的 decoder 是**单例**——一个 `ProtocolCodecFilter` 挂一个 `MessageCodecFactory`，所有会话共用同一个 decoder 对象。所以**绝对不能把"当前读到第几个字节"存在 decoder 的字段上**，否则两个会话同时说话就互相踩。

我当时的做法是：

```java
private static final HashMap<IoSession, Message> messageMap = new HashMap<>();
```

能跑，但有两个代价，而且都是后来才疼的：

1. **`sessionClosed` 时没人 remove** → 每个断开的连接都留一条 `Message` 在里面，长期跑就是慢泄漏。
2. **并发**。MINA 默认是单线程处理某个会话的事件，所以同一个 session 不会被并发 decode；但 `HashMap` 被多个线程同时 put 不同 key 依然不安全。要安全就得换成 `ConcurrentHashMap`，或者加锁。

正解其实是 MINA 自带的那个机制：

```java
session.setAttribute("decoder.buf", message);       // 生命周期跟着 session
session.removeAttribute("decoder.buf");             // 关闭时自动清
// 或者直接在 sessionClosed 里清
```

**用框架给的容器存会话状态，别自己造一个以 session 为 key 的全局 map**——它等价于手写一个没人负责回收的缓存。

## 四、那个把我救回来的全局开关

有一段时期，某个连接会卡住：数据在流动，但解码器一直认为"还没凑齐"，于是一个字节都不产出。查了很久没定位到根因，就先加了个开关：

```java
public static boolean STOP_RIGHT_NOW = false;

// 在 decode 里：
if (STOP_RIGHT_NOW) {
    log.error("STOP_RIGHT_NOW Activated!");
    message.setLength(0);
    STOP_RIGHT_NOW = false;
}
```

语义是"下一次解码直接把这条消息的长度清零，跳过它"。在踢掉一个超时未登录的连接时顺手置上：

```java
retJson.failed(15001, "doesn't login in 7s");
sendMessage(session, retJson);
session.closeNow();
if (lastMessageTime.plusMinutes(1).isBefore(LocalDateTime.now())) {
    MessageDecoder.STOP_RIGHT_NOW = true;
}
```

**它确实救过场**——那个会话不用再等下一批数据就能把状态推过去。

但它也把问题从"一个会话卡住"变成了"所有会话都可能被吞掉一条消息"。因为 `static` 是全局的，谁先跑到下一次 decode，谁就被清。生产上这类开关的典型后果是：**一个偶发的解码卡顿，被转换成了一次随机的消息丢失**，而且日志里看起来像是"对面没发"。

事后总结这条只有一句：**为绕过某一次卡死而加的全局开关，最后都会变成新 bug 的来源。** 真要救场，就把状态机的 `length` 限一个上限（比如 16 MB），超了就断开这个会话——坏也是坏一个。

## 五、编码和解码必须对称，尤其长度

编码器这边是对的：

```java
byte[] contentBytes = msg.getContent().getBytes(StandardCharsets.UTF_8);
buffer.put(Message.magicNumber);
buffer.putInt(contentBytes.length);     // 字节数
buffer.put(contentBytes);
```

它自己重新算了一遍字节数，所以线上是正确的。

问题在实体类：

```java
public Message(String content) {
    this.content = content;
    this.length = content.length();      // 字符数！
}
```

同一个字段，编码侧含义是**字节数**，构造时含义是**字符数**。ASCII 下两者相等，中文就差了 3 倍（UTF-8 一个汉字 3 字节）。现在没炸，只因为编码器不信这个字段、自己重算了一遍——**有人在替这个错误的语义兜底**。哪天有人把 `buffer.putInt(msg.getLength())` 写进去，中文一上线帧就全错位，而且是那种"前面几条好的、突然开始花屏"的错位。

经验只有一条：**协议里只能有一个真相，就是线上那串字节。** 对象内部的 `length` 只能是派生值，永远不能反过来当输入用。要么干脆不存，要用就现算。

## 六、心跳、空闲和登录超时

TCP 的 keepalive 指望不上——Linux 默认 2 小时才探测第一次。要判断"对面还在不在"，得自己在应用层做。

MINA 给了个半成品：

```java
acceptor.getSessionConfig().setIdleTime(IdleStatus.BOTH_IDLE, 10);
```

意思是 10 秒内这个会话**读写都没有**，就触发一次 `sessionIdle`。我在这里面发心跳、收心跳，把超时的连接关掉。

另一半是登录超时：连接建立后 7 秒内没绑定用户就断开。实现上是 `sessionOpened` 里起一个单次定时任务：

```java
ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor();
scheduler.schedule(() -> {
    Unit unit = loginService.getUnitOrNull(session);
    if (unit == null && session.isConnected()) {
        retJson.setCommand("login");
        retJson.failed(15001, "doesn't login in 7s");
        sendMessage(session, retJson);
        session.closeNow();
    }
    scheduler.shutdown();
}, 7, TimeUnit.SECONDS);
```

代码里那句注释交代了 7 秒的来历：

> 7秒后执行任务 服务器刚启动时3秒不能完成loginService的启动。

也就是说，**这个 7 秒是拿启动竞态换来的经验值**，不是协议要求。这类数字最容易被后来的人当成规范，实际上它只是在等一个慢初始化的 Bean。

顺带一个坑：每个连接都 `newSingleThreadScheduledExecutor()`，是个小资源开销。正确做法是全局共享一个调度器。

## 七、后来补的"校验"，真正的用处

最后的提交里有句子叫「完成数据传输中的拼接和校验」「防恶意协议投毒」。听起来像安全特性，实际价值在别处。

在"魔数 + 长度 + 校验"这三层里：

- **魔数**回答"这是不是我的协议"
- **长度**回答"这条消息到哪结束"
- **校验**回答"我按这个长度读出来的东西，真的是对面想发的吗"

第三层不是为了防篡改（这个链路上没人有动机改你的 JSON），而是**让错位立刻可见**。没有校验时，长度算错的表现是：`JSON.parse` 抛出一个莫名其妙的位置异常，或者更糟——恰好能解析，但字段全是错的。加了校验，第一次读错就直接失败，日志里清清楚楚。

**协议里所有的"多余"字段，买的都是可观测性，不是安全。**

## 八、如果重写，会改这五处

| 现在 | 改成 | 因为 |
|---|---|---|
| 4 字节魔数 + 4 字节长度 | 加 1 字节版本号 | 协议一定会变，改的时候要有握手位 |
| `length` 无上限 | 硬编码 16 MB 上限，超限断连 | 一个错位的 4 字节能让你分配 4 GB |
| 静态 `HashMap` 存会话状态 | `session.setAttribute` | 生命周期交给框架，不写回收代码 |
| 业务逻辑写在 `MessageHandler` | 只做分发，业务另开线程池 | 解码线程里做 IO 会堵住整条连接 |
| JSON 正文 | Protobuf / MessagePack | 只为省掉"算长度"和"校验"这两件手工活 |

还有一条不属于协议但很要命：**帧里不写请求 ID。** 这意味着服务端无法把"响应"和"请求"配对，只能靠顺序和命令名猜。一旦出现并发下发，谁对谁就是玄学。后来加 `taskList` 之类的命令时立刻尝到了这个苦——只能约定"一次一个"。

## 收尾

这套东西的结局是：跑起来了，也干完活了，然后停在那里。后来我把服务端和客户端都冻结进了私有仓，只留一句总结：

> 我先来，下辈子再也不用TCP了，说好的稳定无丢失怎么这么多问题（其实一个问题是我C++这边还要手动处理包）

现在回看，那句抱怨其实说对了。TCP 从来承诺的就不是"消息"，它承诺的是**一条可靠的字节流**。边界是应用层的责任，自己造边界，就得自己写完状态机、自己想好长度语义、自己扛住所有"没凑齐"的分支。

这件事在后来的每个项目里都在重复：写协议栈、写解析器、写流式处理——**边界永远不在数据里，在你写的那个状态机里。**
