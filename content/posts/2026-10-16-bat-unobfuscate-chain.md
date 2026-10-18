---
title: "【AIGC】一个 24.9 万字符的 bat：变量消噪做完了，载荷还躺在注释里"
date: 2026-10-16T00:43:04+08:00
lastmod: 2026-10-16T00:43:04+08:00
draft: false
tags: ["逆向", "恶意样本分析", "批处理", "混淆", "Python", "AIGC"]
categories: ["技术笔记"]
description: "一份 526 行、277KB 的混淆批处理，真实命令被拆成随机命名的单字符变量互相引用。写了个责任链式的还原器，!var! 518 处全部消解、526 行压到 16 行；但 %var% 卡住 34 处、第二遍一个字节都没多解出来，而全文 90% 的体积在一条 :: 注释里的 base64 上——消噪不等于挖载荷。"
---

# 样本长什么样

526 行，277,699 字节。打开第一屏是这样的：

```bat
@echo off
%KPjSTBxCcolpNEgJWbqf%s%KPjSTBxCcolpNEgJWbqf%e%KPjSTBxCcolpNEgJWbqf%t%KPjSTBxCcolpNEgJWbqf%l%KPjSTBx...
set "cblMLttYimYYgdCCrjSR=s"
set "ksfjvFgWRcXVFNdVgrjk=t"
set "XufOtBOOdJXCdrpMmnJU=!cblMLttYimYYgdCCrjSR!e!ksfjvFgWRcXVFNdVgrjk!"
```

人眼看到的是噪声，但两件事已经能读出来了：**变量名全是随机大小写混合串**，而且**变量之间会互相引用**（第三个 `set` 的值里套着前两个）。

先做一个最省事的动作：**看体积集中在哪一行。**

数出来是第 141 行，**248,924 个字符**——全文 90% 的体积在这一条行上。这个比例本身就是结论：一个正常的启动脚本不可能有 25 万字符的单行。后面会看到它是什么。

# 混淆手法其实是两层叠在一起的

分清楚这两层很重要，因为还原它们要用完全不同的办法。

**第一层：字符级变量间接引用。**真实命令的每个字符都被换成一个随机变量，然后靠一堆 `set` 把字符喂回去，而且定义可以套定义：

```bat
set "cblMLttYimYYgdCCrjSR=s"
set "ksfjvFgWRcXVFNdVgrjk=t"
set "XufOtBOOdJXCdrpMmnJU=!cblMLttYimYYgdCCrjSR!e!ksfjvFgWRcXVFNdVgrjk!"
```

第三个变量的值是 `!A!e!B!`，展开后是 `set`——**它自己又是一个命令的开头**。所以这不是"查表替换一次"能完事的，定义之间有依赖链。

而且它同时用了两种展开语法：`%var%` 和 `!var!`。后者是 delayed expansion，要 `setlocal enabledelayedexpansion` 才生效。还原器必须两种都认，所以 `translate()` 里那条正则长这样：

```python
special_texts = re.findall(r'!([^!]+?)!|%([^%]+?)%', text)
```

**第二层：未定义变量当分隔符。**开头那行 `%KPjSTBxCcolpNEgJWbqf%s%KPjSTBxCcolpNEgJWbqf%e...` 里的变量，我全文查过：**它从来没被 `set` 过**，只被引用了 32 次。cmd 运行时它展开为空，所以它的唯一作用就是把 `setlocal` 这七个字母隔开。

这一层是纯噪声，处理原则应该是"不认识的就删掉"。而它恰好是还原器卡住的地方，后面讲。

# 还原器：一条责任链

结构很薄，四个文件：

```
main.py                                   BatAnalyzer：持有 keyMap、translate()、log()
service/CommandProcessor/
    CommandProcessorChain.py              责任链：逐行交给处理器
    CommandProcessors.py                  处理器本体（目前只有 setProcessor）
    CommandProcessError.py                解析失败信号
```

有几个决定现在看仍然值得抄：

**装配用 `dir()` 扫。**

```python
all_methods = dir(commandProcessors)
user_defined_methods = [getattr(commandProcessors, m) for m in all_methods
                        if callable(getattr(commandProcessors, m)) and not m.startswith("__")]
self.chain = user_defined_methods
```

加一个处理器 = 给那个类加一个方法，不用碰装配代码。听起来很爽，但有个坑我后来才想明白：**`dir()` 返回的是排序后的名字**，所以链的顺序等于方法名字典序。处理器一多、彼此有先后依赖时（比如"必须先展开变量再判定命令类型"），这个顺序你控制不了，而且它不会报错，只会偶尔给出奇怪的结果。省下的那几行装配代码，是拿隐式的执行顺序换来的。

**一条命令只归一个处理器管。**

```python
for x in self.chain:
    processedLine = x(line)
    if processedLine:
        return processedLine
```

处理器返回空串表示"这条我不管"，第一个返回非空的立刻采纳。这样每个处理器只判断自己那类命令，不用写 if-else 大杂烩。

**全都不管就走兜底，并且记一条日志。**

```python
processedLine = self.batAnalyzer.translate(line)
self.batAnalyzer.log(3, f"command:[{processedLine}] never processed")
```

这条日志差点被我当成还原度指标，**实际上不是**。因为目前唯一的处理器只认领 `set`，所以每一条真实命令——包括已经完美还原出来的那条——都会走兜底路径并被记一条 `never processed`。我拿最小用例复跑时亲眼看到 `exit /b` 被记了这么一条，才反应过来。

它真正的用途是**"哪些行还没有专门的处理器"**，也就是下一步该往链上加什么的清单。做还原确实需要可计量的信号，但得先想清楚这个计数到底在数什么——"没人认领"和"没还原出来"是两回事，前者在这个工具里恰恰等于"已经还原好了"。

**`set` 处理器的取舍。**

```python
def setProcessor(self, command="set a ======1") -> str:
    """
    等号是跑不掉的，是key！
    左边是不需要匹配东西的
    右边。。需要匹配吗？
    似乎也不需要。
    """
```

这段注释是我当时想通的关键：`set` 的语法变体很多（引号、`/a` 算术、`/p` 提示输入），但**等号是唯一的可靠锚点**。所以只按第一个空格切出命令字、再按第一个等号切成 key 和 value，两边都不做复杂匹配。value 走 `translate()` 展开，然后登记进 `keyMap`。

**输出丢掉 `set` 行。**

```python
if processedLine[:3] == "set":
    # 写set没有任何意义
    continue
```

因为定义已经在 `keyMap` 里被消费掉了。还原的产物是**给人读的命令序列**，不是一个还能跑的第二版脚本——保留那几百行随机变量定义只会让读者以为它们还有意义。

# 战果

对那份 526 行的样本，跑一遍：

| 指标 | 还原前 | 一遍后 | 两遍后 |
|---|---|---|---|
| 行数 | 526 | 16 | 32 |
| 残留 `!var!` | 518 | **0** | 0 |
| 残留 `%var%` | 550 | 34 | 34 |
| 最长行 | 248,924 | 248,924 | 248,924 |

**`!var!` 518 处全部消解，一个不剩。**还原出来的可见命令长这样：

```bat
@echo off
net file > nul 2>&1
```

`net file` 需要管理员权限才能执行，把它重定向到空设备再判返回值，是最经典的**"我现在是不是管理员"**探测。所以这个脚本的可见部分是在做权限检查，逻辑通顺。

最小用例 `test2`（69 字节）也验证了链式定义这条路走得通：

```bat
set "cjkHkmgTLA=exit"
set "nQHuBNdcxY= /b"
%cjkHkmgTLA%%nQHuBNdcxY%
```
还原输出 `exit /b`。

# 但有三件事它没做到

**一、那 34 处 `%var%` 永远消不掉。**

原因就是前面说的第二层手法：`KPjSTBxCcolpNEgJWbqf` **从未被定义**。而 `translate()` 的逻辑是"在 `keyMap` 里找 key，找到才替换"——对不认识的变量，它一个字都不会动。

所以缺的不是算力，是**一条规则**：`%X%` 形式的变量如果在 `keyMap` 里查不到，就应该直接删掉，而不是留着。这条规则一加上，34 处立刻归零。

**二、第二遍是白跑的。**

我当时的想法是：定义有顺序依赖，第一遍遇到"后面才定义的变量"时无能为力，所以跑完一遍让 `keyMap` 变全，再跑第二遍应该能多解一些。

数据打脸了：`34 → 34`，最长行**一个字符都没变**。第二遍什么都没多解出来。

至于行数为什么从 16 涨到 32，也不是解出了新东西——`processFile` 每写一行都带一个空行（`fw.write(f"{processedLine}\n\n")`），第二遍把自己的空行当输入又处理了一遍。**输出格式污染了输入**，这是把中间态存成文件、再喂回自己时特别容易踩的坑。

正确的结论是：多遍迭代这个设计方向没错，但**它只能解决"定义在后面"的问题，解决不了"根本没有定义"的问题**。前者靠迭代收敛，后者靠补规则。我当时没区分这两类，所以白跑了一遍。

**三、真正该挖的东西一步没碰。**

回到那个 248,924 字符的单行。它开头是：

```
:: C/QyRCXNTydczmkXgjl+Ht/++ghdkt3h+6NRzXPbHIb8sDNNN5q83Lxx...
```

`::` 在批处理里是**注释**，cmd 直接跳过。也就是说这个脚本随身扛着约 25 万字符的 base64，而解释器运行时会完全无视它——前面那些还原出来的可见命令（权限探测之类）负责决定什么时候、用什么方式把这段注释里的东西取出来落地执行。

而我的还原器对它做了什么？**什么都没做。**它不是 `set` 开头，所有处理器都返回空，走兜底 `translate()`，里面没有可替换的变量，于是原样写出，还顺手记了一条 `never processed`。

**消噪不等于挖载荷。**这份样本里，消噪解决的是那 16 行可见命令的可读性，而 90% 的威胁藏在一条被完整保留、原样搬运的注释里。还原器把它"安全地"留在了输出中，看起来像是处理过了，实际上一步没走。

# 收尾

两个可以搬走的判据，都比写代码重要：

1. **拿到混淆样本，先看体积集中在哪一行。**一个正常脚本不会有 25 万字符的单行。这一眼就能告诉你"真正要看的东西在哪"，而不是从第一行开始顺序读。
2. **顺便看哪些行是解释器会跳过的。**`::`、`rem`、重定向到 `nul` 的内容、写在引号里但从没被调用的字符串——解释器忽略的东西，正是载荷最好的藏身处，因为作者知道没人会去看。

以及一条方法论上的自我修正：**"跑第二遍看能不能更好"是个好直觉，但要先想清楚第二遍凭什么会更好。**我的 `keyMap` 在第二遍确实更全了，可那 34 处的问题不是"map 不全"而是"这个 key 不存在"。方向判断错了，多跑一遍只是多花一倍时间拿同一个结果。

工具本体放在公开仓：https://cnb.cool/t1mmoc/tspace/pwngore/h8bat-unobfuscate

仓里带了一个 69 字节的手写最小用例 `examples/test2.bat.data`，跑 `python examples/run_example.py` 能复现出 `exit /b`，与 `examples/test2.expected` 逐字节一致。真实样本和各阶段中间态都不入库。
