---
title: "碰壁之旅：一个伪装成反间谍软件的样本，和那段跳进指令中间的 shellcode"
date: 2026-10-16T19:10:00+08:00
lastmod: 2026-10-16T19:10:00+08:00
draft: false
tags: ["恶意样本分析", "逆向", "IDA", "x64dbg", "010 Editor", "shellcode", "IDAPython", "VMware"]
categories: ["技术笔记"]
description: "一个签名有效、版本只差 2、字符串全是 SQLite 的 SUPERAntiSpyware，和正版差了 0.0.2 个版本。静态 diff 排到全是业务逻辑，动态跑它自己退、网络 0 条。最后是靠自己写的一个判据捞回来的：枚举所有指令头，凡是跳转目标不落在指令边界上的，就是有人往指令流中间插了代码。"
---

# 新样本

优先使用静态分析，那就先获取足够的信息再说吧。

![image-20250523142534267](/images/shellcode-inject-hunt/image-20250523142534267.png)

用户名没有特别信息，反间谍软件吗，这个取名有点意思。

检查字符串，发现大量数据库相关代码

![image-20250523143612928](/images/shellcode-inject-hunt/image-20250523143612928.png)

不太正常，很像一个普通软件，可能是被中木马了。

使用的数据库类型是SQLite

![image-20250523143657366](/images/shellcode-inject-hunt/image-20250523143657366.png)

![image-20250523143729122](/images/shellcode-inject-hunt/image-20250523143729122.png)

找到官网，看看源文件。



在看源文件之前发现一件神奇的事情：

![image-20250523143837356](/images/shellcode-inject-hunt/image-20250523143837356.png)

数字签名正常，签名时间，啊？昨晚？

这么新鲜的样本吗，而且数字签名正常也离谱。

![image-20250523144119880](/images/shellcode-inject-hunt/image-20250523144119880.png)

![image-20250523144131423](/images/shellcode-inject-hunt/image-20250523144131423.png)

获取的样本版本低了官网两个迭代版本。

![image-20250523144426853](/images/shellcode-inject-hunt/image-20250523144426853.png)

ok，没事了。

![image-20250523145236832](/images/shellcode-inject-hunt/image-20250523145236832.png)

发现只存在于样本中的字符串

 sub_1402A3D20

![image-20250523145321867](/images/shellcode-inject-hunt/image-20250523145321867.png)

![image-20250523145329088](/images/shellcode-inject-hunt/image-20250523145329088.png)

只存在于样本中的函数，疑似是根据日期触发。

![image-20250523145551442](/images/shellcode-inject-hunt/image-20250523145551442.png)

![image-20250523145608872](/images/shellcode-inject-hunt/image-20250523145608872.png)

我感觉有另一种可能性：

外面进行了一种伪装，里面进行了另一种伪装。也就是里面伪装成了另一个不同的程序。

![image-20250523145829519](/images/shellcode-inject-hunt/image-20250523145829519.png)

![image-20250523145933897](/images/shellcode-inject-hunt/image-20250523145933897.png)

![image-20250523145951461](/images/shellcode-inject-hunt/image-20250523145951461.png)

sub_140177DF0 疑似解密shellcode，使用文本：

![image-20250523150022585](/images/shellcode-inject-hunt/image-20250523150022585.png)

找到-help信息：

![image-20250523150056481](/images/shellcode-inject-hunt/image-20250523150056481.png)

![image-20250523150139524](/images/shellcode-inject-hunt/image-20250523150139524.png)

安装和卸载信息GUID

![image-20250523150206175](/images/shellcode-inject-hunt/image-20250523150206175.png)

不存在于官网程序中，不知道该GUID的用途，记下来：CDDCBBF1-2703-46BC-938B-BCC81A1EEAAA

![image-20250523150312027](/images/shellcode-inject-hunt/image-20250523150312027.png)

961c151d2e87f2686a955a9be24d316f1362bf21 3.11.3

![image-20250523150334583](/images/shellcode-inject-hunt/image-20250523150334583.png)

![image-20250523150349866](/images/shellcode-inject-hunt/image-20250523150349866.png)

![image-20250523150412274](/images/shellcode-inject-hunt/image-20250523150412274.png)

sub_1400C8110：

![image-20250523150437785](/images/shellcode-inject-hunt/image-20250523150437785.png)

sub_1402060A0：

![image-20250524095520305](/images/shellcode-inject-hunt/image-20250524095520305.png)

 sub_1400CA130：

![image-20250523150520880](/images/shellcode-inject-hunt/image-20250523150520880.png)

噢？获取信息？这我熟悉，看看：

![image-20250523150603465](/images/shellcode-inject-hunt/image-20250523150603465.png)

![image-20250523150626489](/images/shellcode-inject-hunt/image-20250523150626489.png)

跟踪，但是没找到调用来源，具体来说不知道是谁在使用这个指针。

![image-20250523150634179](/images/shellcode-inject-hunt/image-20250523150634179.png)

![image-20250523150732013](/images/shellcode-inject-hunt/image-20250523150732013.png)

![image-20250523150736605](/images/shellcode-inject-hunt/image-20250523150736605.png)

这是dll吗？不过想到一个的思路，想要调用某个函数的时候不直接调用，而是翻找自己的导出表，然后遍历x个函数以后调用（需要被调用的函数导出一下子），就是这样做的话小改一下就难以维护。

![image-20250523151004123](/images/shellcode-inject-hunt/image-20250523151004123.png)

一个md5

FILEDATAMD5@[ac6ad5d9b99757c3a878f2d275ace198]:+0:2

![image-20250523151043925](/images/shellcode-inject-hunt/image-20250523151043925.png)

有点像。sub_14002D160。

![image-20250523151141689](/images/shellcode-inject-hunt/image-20250523151141689.png)

另一串收集信息。sub_140016320



![image-20250523151310243](/images/shellcode-inject-hunt/image-20250523151310243.png)

有sqlite还用azure？有点像获取了数据以后提交云服务器，跟踪看看

![image-20250523151345148](/images/shellcode-inject-hunt/image-20250523151345148.png)

![image-20250523151415099](/images/shellcode-inject-hunt/image-20250523151415099.png)

![image-20250523151736351](/images/shellcode-inject-hunt/image-20250523151736351.png)

签名写死，只为获得a2？

# 初步检查字符串完毕，下一步

### 在此之前，检查一下段吧

![image-20250524094808868](/images/shellcode-inject-hunt/image-20250524094808868.png)

这个段有点怪，是这样的吗

疑似 002fb24e之类的写法。

![image-20250524095158390](/images/shellcode-inject-hunt/image-20250524095158390.png)

0%的overlay吗，资源刚刚也翻了一遍没找到什么特别的东西。

010对比也过了，结论是：只有外壳是伪造的，内部的代码完全不相关。

### 下一步，分析代码

首先入手的地方是：既然代码不相关，为什么会有相似的字符串？

sub_1401F21B0：相关字符串：获取管理员权限，打开SCManager

![image-20250524100600239](/images/shellcode-inject-hunt/image-20250524100600239.png)

![image-20250524100629417](/images/shellcode-inject-hunt/image-20250524100629417.png)

### 下一个突破口

搁置，还是觉得唯一的http链接非常可疑。

![image-20250524101128941](/images/shellcode-inject-hunt/image-20250524101128941.png)

检查发现a2获取的数据是一个.zip数据

![image-20250524101230795](/images/shellcode-inject-hunt/image-20250524101230795.png)

![image-20250524102023447](/images/shellcode-inject-hunt/image-20250524102023447.png)

疑似收集了以上数据（sub_140204C70 列为可疑）

![image-20250524101256406](/images/shellcode-inject-hunt/image-20250524101256406.png)

在同函数内找到了.zip的全名，可疑度++

往上追溯上一级，发现

![image-20250524102341785](/images/shellcode-inject-hunt/image-20250524102341785.png)

异常处理？还有模有样的，难道那串地址真的是原版的？

检查一下。



原版：

![image-20250524102638054](/images/shellcode-inject-hunt/image-20250524102638054.png)

样本：

![image-20250524102916378](/images/shellcode-inject-hunt/image-20250524102916378.png)

啧，这send dbg还真是唬人，我倒是想虚拟机里面动态运行一遍了。

疑似收集信息，使用微软的容器存储服务进行收集，类似于网盘。

其中邮箱来源是用的原版的注册信息邮箱。

### 下一个突破口

线索断了，再检查：help信息

```
   -ascii               set output mode to 'ascii'
   -bail                stop after hitting an error
   -batch               force batch I/O
   -column              set output mode to 'column'
   -cmd COMMAND         run "COMMAND" before reading stdin
   -csv                 set output mode to 'csv'
   -echo                print commands before execution
   -init FILENAME       read/process named file
   -[no]header          turn headers on or off
   -help                show this message
   -html                set output mode to HTML
   -interactive         force interactive I/O
   -line                set output mode to 'line'
   -list                set output mode to 'list'
   -lookaside SIZE N    use N entries of SZ bytes for lookaside memory
   -mmap N              default mmap size set to N
   -newline SEP         set output row separator. Default: '\n'
   -nullvalue TEXT      set text string for NULL values. Default ''
   -pagecache SIZE N    use N slots of SZ bytes each for page cache memory
   -scratch SIZE N      use N slots of SZ bytes each for scratch memory
   -separator SEP       set output column separator. Default: '|'
   -stats               print memory stats before each finalize
   -version             show SQLite version
   -vfs NAME            use NAME as the default VFS
```

![image-20250524104333004](/images/shellcode-inject-hunt/image-20250524104333004.png)

![image-20250524104350460](/images/shellcode-inject-hunt/image-20250524104350460.png)

是一个SQLite操作库



思考：这个程序为什么需要SQLite数据库，而且看着有不少INSERT操作？

![image-20250524104846920](/images/shellcode-inject-hunt/image-20250524104846920.png)

![image-20250524104840398](/images/shellcode-inject-hunt/image-20250524104840398.png)

记录日志，这可能是之前提到的applog。

### 下一个突破口

检查一下之前找到的计划任务。

![image-20250524105155016](/images/shellcode-inject-hunt/image-20250524105155016.png)

![image-20250524105306496](/images/shellcode-inject-hunt/image-20250524105306496.png)

疑似是一个扫描全部tasks的函数，并非记录自己的task

怎么做到的，这么像一个正常的软件

**而且官网那边只更新了两个小版本，但是官网那边的字符串全部都换了一遍**

**有没有可能，官网那个是安装包**

嘶。。。。。

我咋忘了这件事了。

官网原版：

![image-20250524105515269](/images/shellcode-inject-hunt/image-20250524105515269.png)

好，虚拟机安装一下（原版）。

![image-20250524105855082](/images/shellcode-inject-hunt/image-20250524105855082.png)

![image-20250524105913145](/images/shellcode-inject-hunt/image-20250524105913145.png)

这个对比图，对胃了。

**感情我一直在拿着安装包和安装后的软件进行对比？**吃一堑长一智了。

**那么，以上的字符串对比的作用显得非常微弱。**

尾部原文件填充处存在一些字符串，但其中混杂了部分不可打印字符。

![image-20250524111139642](/images/shellcode-inject-hunt/image-20250524111139642.png)

样本的3F9BF0h开始，疑似存在在空闲位置插入数据现象。

![image-20250524111623648](/images/shellcode-inject-hunt/image-20250524111623648.png)

该位置处于rsrc

![image-20250524111724516](/images/shellcode-inject-hunt/image-20250524111724516.png)

将原版（这次不是安装包了）放到ida中分析：

![image-20250524112339952](/images/shellcode-inject-hunt/image-20250524112339952.png)

肯定是改自这个的了。

![image-20250524112440603](/images/shellcode-inject-hunt/image-20250524112440603.png)

再对比一下两个数字签名。

# 再来一次，对比样本和原版

![image-20250524112617826](/images/shellcode-inject-hunt/image-20250524112617826.png)

task，有

### 下一个突破口

![image-20250524112700534](/images/shellcode-inject-hunt/image-20250524112700534.png)

### 下一个突破口

![image-20250524112727289](/images/shellcode-inject-hunt/image-20250524112727289.png)

### 下一个

![image-20250524112803884](/images/shellcode-inject-hunt/image-20250524112803884.png)

### 下一个

![image-20250524112821851](/images/shellcode-inject-hunt/image-20250524112821851.png)

### 下一个

![image-20250524112858274](/images/shellcode-inject-hunt/image-20250524112858274.png)

### 下一个

![image-20250524112917064](/images/shellcode-inject-hunt/image-20250524112917064.png)

### 下一个

![image-20250524112948850](/images/shellcode-inject-hunt/image-20250524112948850.png)

### 下一个

![image-20250524113053332](/images/shellcode-inject-hunt/image-20250524113053332.png)

### 下一个

![image-20250524113120752](/images/shellcode-inject-hunt/image-20250524113120752.png)

### 下一个

![image-20250524113231530](/images/shellcode-inject-hunt/image-20250524113231530.png)

### 全部可疑字符串都和原版一致

# 再次检查样本基本属性

全部突破口都没有追踪到实际确定的部分，得再看一遍基础信息。

rsrc段中存在奇怪数据，但rsrc不可运行，感觉应该着重寻找text中的奇怪数据。

但在此之前先对比一下pe结构好了。显示的overlay是数字签名，实际上两个都没有overlay。

![image-20250524113543444](/images/shellcode-inject-hunt/image-20250524113543444.png)

样本还少了几个资源？我看看资源有什么特别的

![image-20250524113645111](/images/shellcode-inject-hunt/image-20250524113645111.png)

缺少的应该是图标，没发现异常之处。

![image-20250524114114881](/images/shellcode-inject-hunt/image-20250524114114881.png)

只有text可执行，大小基本都变了一圈，这倒也正常，因为没能拿到相同版本的程序，说起来还没看过版本，看一下：

![image-20250524114200957](/images/shellcode-inject-hunt/image-20250524114200957.png)

也是1274，样本是1272

### 未发现可疑，下一步

该检查text里面不同的地方了

![image-20250524114713955](/images/shellcode-inject-hunt/image-20250524114713955.png)

![image-20250524114734561](/images/shellcode-inject-hunt/image-20250524114734561.png)

寻找比较大的地方对比

是时候进行ida的foa转rva了。

![image-20250525101406686](/images/shellcode-inject-hunt/image-20250525101406686.png)

因为image base设置不了负数，虚拟地址比物理地址大，就加个一千好了，这样也方便算。

### 可能是突破口

**FOA：0x29d4**

**手动修改的VA：0x39d4（image base：0x400）**

疑似修改日志部分嵌入碎片化代码。

![image-20250525101536784](/images/shellcode-inject-hunt/image-20250525101536784.png)

样本在左边，注册了一个退出前函数

![image-20250525101634589](/images/shellcode-inject-hunt/image-20250525101634589.png)

该函数不存在于原版中。

Qword是运行时赋值

![image-20250525101812606](/images/shellcode-inject-hunt/image-20250525101812606.png)

![image-20250525101826830](/images/shellcode-inject-hunt/image-20250525101826830.png)

但是存在多个交叉引用，不太方便查找。

### 另一个地方

FOA：0x2c1f，存在0x10d的不同

![image-20250525102345548](/images/shellcode-inject-hunt/image-20250525102345548.png)

![image-20250525102410415](/images/shellcode-inject-hunt/image-20250525102410415.png)

![image-20250525102321742](/images/shellcode-inject-hunt/image-20250525102321742.png)

### 下一个

FOA图片写了，不抄了

![image-20250525102513869](/images/shellcode-inject-hunt/image-20250525102513869.png)

![image-20250525102604736](/images/shellcode-inject-hunt/image-20250525102604736.png)

这里没什么可疑的，看起来是正常的版本迭代增加了点参数。所以没拿到原始版本是挺亏的。

### 下一个

![image-20250525103111940](/images/shellcode-inject-hunt/image-20250525103111940.png)

![image-20250525103104318](/images/shellcode-inject-hunt/image-20250525103104318.png)



### 不行，不能这样排查了

不同的地方太多了，每个100字节的地方都有可能是shellcode，毕竟shellcode可以非常小

按照大小顺序编排吧，目前可疑的地方是推出前注册了一个函数，使用了一个在运行时才初始化的指针。

如果样本作者非常细腻地将这个指针的赋值，安插在各个地方，使得每个地方都不会异常的大，那样我会非常难以排查。

但如果样本作者只是用的自动化程序感染原版文件，那我相信他替换的shellcode肯定会比较巨大，顺着这个思路查找吧。

首先需要明确：

![image-20250525103600274](/images/shellcode-inject-hunt/image-20250525103600274.png)

text段的范围为 400 - 33c800。

其他段均不可执行，因此shellcode即使在其他段，也必须有一个text段的小shellcode去引导修改执行状态。



### 还是不行

我还是没想到相差0.0.2个版本居然会相差这么多代码，从大小排序的话，排查到的**全是业务逻辑**。

换个思路。



### 程序空洞

检查一下对齐吧。

![image-20250525105203184](/images/shellcode-inject-hunt/image-20250525105203184.png)

红色的线条画出的是text的分割线，这样看来，原版其实更像恶意样本。

![image-20250525105430982](/images/shellcode-inject-hunt/image-20250525105430982.png)



# 没找到，运行一下

当然，我说的是去虚拟机运行。

没有思路了，断网，运行，看它到底要干啥，是勒索？是远控？还是挖矿。

![image-20250525105748248](/images/shellcode-inject-hunt/image-20250525105748248.png)

![image-20250525105759516](/images/shellcode-inject-hunt/image-20250525105759516.png)

毕竟是最新的样本，给点尊重，与主机完全隔离。

![image-20250525105857509](/images/shellcode-inject-hunt/image-20250525105857509.png)

肉眼上没有任何效果，只是打开了一段时间自动关闭了。

很像远控找不到服务器，上procmon

![image-20250525110034800](/images/shellcode-inject-hunt/image-20250525110034800.png)

0的网络数据，难道是知道没有网络所以没运行？那我估计得给他个假网络了。

也可能是因为我没有装过原版，安装原版尝试一下。

![image-20250525110225614](/images/shellcode-inject-hunt/image-20250525110225614.png)

再试一次，一样自己退了，难道是检查到虚拟机？

给个假网络试试。这不能虚拟机逃逸吧

![image-20250525110339409](/images/shellcode-inject-hunt/image-20250525110339409.png)

没用，依旧是0的网络+启动后自己结束自己。



给个管理员权限试试。

一模一样，啥都没干。



# virustotal

上vt吧，看看vt是怎么分析它的。

不交样本上去了，交个哈希上去看看

![image-20250525110742408](/images/shellcode-inject-hunt/image-20250525110742408.png)

好的，已经有人交过这个样本了，看看分析结果

![image-20250525110928997](/images/shellcode-inject-hunt/image-20250525110928997.png)

啧，几乎算得上啥都没干

但是不对：

![image-20250525111109894](/images/shellcode-inject-hunt/image-20250525111109894.png)

![image-20250525111142222](/images/shellcode-inject-hunt/image-20250525111142222.png)

释放并打开，我怎么没有。

噢，我没装谷歌浏览器。

看看微步那边有没有上传过这个样本

![image-20250525111309701](/images/shellcode-inject-hunt/image-20250525111309701.png)

我就知道是绿的。

![image-20250525111323983](/images/shellcode-inject-hunt/image-20250525111323983.png)

rsrc可能存在一定问题，但之前静态ida都没分析出啥。

![image-20250525111440817](/images/shellcode-inject-hunt/image-20250525111440817.png)

跟我的结果一样，那我就不找个没vmtools的机器再跑一遍了，应该都差不多。



# 使用脚本

![image-20250525115624025](/images/shellcode-inject-hunt/image-20250525115624025.png)

Cur:140024cec-->Inject_addr:140022fd0



140022FB6 -> 00000001401A552E (ret) -> 0000000140022FBB (shellcode)



# 寻找第二段shellcode

在断下第一段shellcode的入口后，尝试断点 NtProtectVirtualMemory 但是失败。

根据提示，存在内存中运行的代码。

程序退出时拦截，找到多段可执行内存块。

![image-20250528104332967](/images/shellcode-inject-hunt/image-20250528104332967.png)

重新运行程序，发现程序在刚开始运行时已经出现该内存块

![image-20250528104647906](/images/shellcode-inject-hunt/image-20250528104647906.png)

![image-20250528104730749](/images/shellcode-inject-hunt/image-20250528104730749.png)

其中发现unpack.exe字样，继续跟踪，发现

00000001402E07C2->00000000024D0000

![image-20250528105233365](/images/shellcode-inject-hunt/image-20250528105233365.png)

![image-20250528105405270](/images/shellcode-inject-hunt/image-20250528105405270.png)

为何要调用蓝牙功能？这也是检查虚拟机的一种方法吗？

重新运行一遍程序，注意到heap2下的内存是后分配的。

![image-20250528105533105](/images/shellcode-inject-hunt/image-20250528105533105.png)

想到一个可行的：shellcode如果要隐藏自己的堆栈，可以选择用带callback的各种系统函数，createThread可能太明显了，但是如果是注册一个回调，也许有各种不同的方法可以达成。



避免被断点的方法：自己手写前面的几个部分，然后跳转到syscall。

![image-20250528110915930](/images/shellcode-inject-hunt/image-20250528110915930.png)

![image-20250528110905362](/images/shellcode-inject-hunt/image-20250528110905362.png)





这样就断下来了。

不过有个小问题，既然都是syscall，为什么不直接在shellcode中写 0F05，还要调用原始的syscall呢

![image-20250528111050133](/images/shellcode-inject-hunt/image-20250528111050133.png)

# 收尾

工具和数据在 [cnb.cool/t1mmoc/tspace/pwngore/h33-shellcode-inject-hunt](https://cnb.cool/t1mmoc/tspace/pwngore/h33-shellcode-inject-hunt)。

`Search_Inject.py` 是这篇里唯一真正解决问题的东西，明文放在仓库根目录，可以直接拿去 IDA 里跑。其余的——样本 `Meizhou.bin`、两个正版参照物（安装包 231 MB + 装完的主程序 12 MB）、内存 dump、Procmon 日志——都是明文恶意载荷或第三方成品，统一收在 `样本与参照物.tar.gz.gpg` 里，7 个条目 232.8 MB。

**这篇没有结论。** 到最后我也没说清那段 shellcode 到底要干什么：断网跑它自己退、给假网络自己退、给管理员权限自己退、装了正版再跑还是自己退，Procmon 抓到 0 条网络活动；VT 上别人那份报告写着「释放并打开」，我这边复现不出来，因为虚拟机里没装 Chrome。微步是绿的。

静态那条路更早就断了——和正版的差异多到没法按大小排序排查，因为**我一开始拿的是安装包当参照物**，白比了一整天。
