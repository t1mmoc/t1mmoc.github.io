---
title: "一个 FakeApp dropper：样本不配合的这四十天"
date: 2026-10-16T13:57:01+08:00
lastmod: 2026-10-16T13:57:01+08:00
draft: false
tags: ["恶意样本分析", "逆向", "IDA", "火绒剑", "Process Monitor", "FakeApp"]
categories: ["技术笔记"]
description: "一个 FakeApp 家族的木马 dropper：IDA 双击没反应、火绒剑只看到它在睡觉、VT 报告全是反沙箱。断 memmove 追 buf、发现 shellcode 解出来后新建线程执行、再从内存段里导出真正的恶意 DLL。中间踩的最大的坑不是反分析，是一句早就知道却没去用的运行条件。"
---

# 上木马！

听有个朋友说他挨了病毒，我看看怎么个事。

![](/images/fakeapp-dropper/2024-07-15-17-28-00-image.png)

---

# 初次分析

先镜像，然后ida丢进去看一眼，没条理，双击一下逝逝，没反应

上火绒剑，只执行了一小部分就开始睡觉了

![](/images/fakeapp-dropper/2024-07-15-17-24-26-image.png)

没读写关键目录，没创建子进程避免读日志，还真就在睡觉？

![](/images/fakeapp-dropper/2024-07-15-17-24-58-image.png)

![](/images/fakeapp-dropper/2024-07-15-17-25-06-image.png)

一个笑话：未发现风险。

vt的报告里面除了联网以外也没见有做什么特别的事情，倒是一堆的反沙箱和虚拟机。

看来是被检查到了，得绕过一下。。。

---

![](/images/fakeapp-dropper/2024-07-15-17-26-13-image.png)

喜欢翻字符串，刚刚试着运行后暂停回滚堆栈跳出循环，然后程序直接一步到底了，也没见发作。

这串字符串有点奇怪![](/images/fakeapp-dropper/2024-07-15-17-27-03-image.png)

因此紧接着，引用它的这串代码也有点奇怪。记录下来了。

但是太多了，分析不过来。

没见可读的字符串，不是勒索软件，联网也没进行，这个应该是检测到沙箱了，vt是有说联网的。

看来还是得先破他的沙箱检查。

---

寻求了一下场外援助

找了个朋友问了一嘴，他给了个方向。

再丢进火绒剑分析，没有。

找了个有添加计划任务的程序来测试，火绒剑里面找不到添加计划任务的项目。。是被漏掉了吗？

不管了，ProcessMonitor，启动

![](/images/fakeapp-dropper/2024-08-10-09-37-42-image.png)

好吧忘了这玩意开不起来

没关系，我还有一个虚拟机，截到了关键的代码

![](/images/fakeapp-dropper/2024-08-10-09-40-37-image.png)

![](/images/fakeapp-dropper/2024-08-10-09-41-57-image.png)

有读自身，是读buf吗？

后续一直在请求这个sys循环，而我没有给他管理员权限，所以不可能是写入，只是在读取。

但是一直获取不到。。。结合之前的信息，本来应该是有个安装包里面有个sys，然后他去读这个sys获取shellcode，再运行？

或者用sys给自身提权，sys只作为提权后门不作为运行后门避免被杀也是有可能的。

这个程序本身没有做什么特别的事情

用管理员权限重新运行了一遍这个软件，并没有遇到特别的信息，仍然是在读取Windows Crashpads里面的TrackerUI.sys无限循环不带sleep。

![](/images/fakeapp-dropper/2024-08-10-10-21-31-image.png)

有前人研究？看看~~

![](/images/fakeapp-dropper/2024-08-10-10-21-52-image.png)![](/images/fakeapp-dropper/2024-08-10-10-33-00-image.png)![](/images/fakeapp-dropper/2024-08-10-10-33-17-image.png)![](/images/fakeapp-dropper/2024-08-10-10-33-27-image.png)![](/images/fakeapp-dropper/2024-08-10-10-34-01-image.png)

好吧，看来依靠前人的智慧是没希望了。

但是等等，我说，有没有可能，我开不开梯子都连不上，是我的问题呢？

直接连卡饭官网，连不上，好，远程链接启动。

![](/images/fakeapp-dropper/2024-08-10-10-37-52-image.png)

无语了，我是进了卡饭黑名单吗这么对我

![](/images/fakeapp-dropper/2024-08-10-10-41-44-image.png)

登录后也查看不了，应该是图片。

随便翻翻看大佬们都是怎么说这个东西的好了。

**都在贴杀软和病毒扫描工具的查杀截图**，没人分析，好吧，

![](/images/fakeapp-dropper/2024-08-10-10-43-46-image.png)

![](/images/fakeapp-dropper/2024-08-10-10-43-39-image.png)

有效信息如上，但是两个信息我都知道了。

![](/images/fakeapp-dropper/2024-08-10-10-46-05-image.png)

![](/images/fakeapp-dropper/2024-08-10-10-47-58-image.png)

好吧，看来还是得回去找这个TrackerUI.sys是怎么解密成字符串的。

这个应用也就干了这件事了，找到怎么解密成字符串就结束了。

![](/images/fakeapp-dropper/2024-08-10-10-47-16-image.png)

眼瞎，第一次分析的时候没看到，现在突然看到字符串里面明晃晃的有这个目录，想把之前没看到的自己打一遍

![](/images/fakeapp-dropper/2024-08-10-10-48-54-image.png)

三条，同一子函数，来看看这个子函数都干了什么吧

![](/images/fakeapp-dropper/2024-08-10-10-50-01-image.png)

609行，先给ai看一遍，太乱了。

不过在给ai看之前，我也发现了一些东西

![](/images/fakeapp-dropper/2024-08-10-10-50-40-image.png)

这个在很底部的位置，其实可以判断这整个函数是寻找->调用 的思路，但如果是这样，那我就没法继续分析了，因为调用完那主动权就在sys那边了。

![](/images/fakeapp-dropper/2024-08-10-10-53-40-image.png)

---

拿一下原始样本

![](/images/fakeapp-dropper/2024-08-10-10-55-16-image.png)

![](/images/fakeapp-dropper/2024-08-10-10-56-05-image.png)

好嘛，分析了半天就分析了一个dll加载器。

来看看sys里面有什么好了

![](/images/fakeapp-dropper/2024-08-10-11-06-39-image.png)

好像有什么不对？是障眼法吗？总不能是文件损坏吧。

![](/images/fakeapp-dropper/2024-08-10-11-09-23-image.png)

文件没有损坏，因为可以直接vt查到

![](/images/fakeapp-dropper/2024-08-10-11-10-28-image.png)

换了个虚拟机，然后这是什么？签名的安装包？坏了，不会是病毒作者已经收工了吧

![](/images/fakeapp-dropper/2024-08-10-11-14-43-image.png)

![](/images/fakeapp-dropper/2024-08-10-11-13-13-image.png)

没了，行吧，样本被撤了

或者就是判断我不是攻击目标，在下载的时候不给我正确的样本。

---

![](/images/fakeapp-dropper/2024-08-10-11-15-07-image.png)

![](/images/fakeapp-dropper/2024-08-10-20-02-34-image.png)

Phone里面的sub_40DA80调用了读入TrackerUI，并且有一个比较奇怪的字符串，可能是混淆

![](/images/fakeapp-dropper/2024-08-10-20-05-03-image.png)

翻看sys，究竟是调用了哪个函数呢。。。

![](/images/fakeapp-dropper/2024-08-10-20-04-25-image.png)

逐个翻看函数，没有看到特别多代码的函数

![](/images/fakeapp-dropper/2024-08-10-20-07-04-image.png)

字串也没东西。

对比一下两个代码量

![](/images/fakeapp-dropper/2024-08-10-20-07-40-image.png)

![](/images/fakeapp-dropper/2024-08-10-20-08-50-image.png)

（这个是代码最多的一个了）

奇怪我这sys保不保真的啊

![](/images/fakeapp-dropper/2024-08-10-20-09-33-image.png)

什么什么还有高手？这个sys是假的？42 8F的文件头什么都不是？

还是说sys不能丢进这里判？

![](/images/fakeapp-dropper/2024-08-10-20-12-01-image.png)

随便找了个系统的sys文件来看，好，还有高手。现在我知道不该什么都往ida里面丢了。

这个表面上是sys，实际上不会是zip什么的数据文件吧？

或者真的是一个sys文件只不过经过了加密，在内存中解密？

---

![](/images/fakeapp-dropper/2024-08-20-14-53-51-image.png)

找到了关键的buf转移，感觉跟踪还是主要跟踪buf才行。

目标新建了一个线程用于buf的运行，可能也包含解密，因此得跟入检查。

![](/images/fakeapp-dropper/2024-08-20-14-54-54-image.png)

看起来目标是从头运行的。

---

0040D338 memmove(v47, v41, v17);

断一下v47的读buf。应该能找到下一步调用。

v47直接就是可运行的指令，新建了线程调用这部分指令。

![](/images/fakeapp-dropper/2024-08-25-15-06-59-image.png)

![](/images/fakeapp-dropper/2024-08-25-15-08-41-image.png)

经过对比，发现v47的内容和sys里面的十六进制不同，经过了一次解密成为汇编代码。

回头检查解密代码，找到了，v41初始化然后逐项赋值，看出来是解密代码。

![](/images/fakeapp-dropper/2024-08-25-15-06-53-image.png)

但是v47如何分析？不在标准结构内，能导出给ida分析吗？

单步观察注释，发现明显的MZ字段，跟随发现一个比较可疑的内存段，但是来源还未知。打算导出看看。

![](/images/fakeapp-dropper/2024-08-25-15-21-49-image.png)

![](/images/fakeapp-dropper/2024-08-25-15-30-46-image.png)

导出得到一个dll

![](/images/fakeapp-dropper/2024-08-25-15-31-37-image.png)

哟吼，作者还是国人，这下好玩了。

![](/images/fakeapp-dropper/2024-08-25-15-32-08-image.png)

![](/images/fakeapp-dropper/2024-08-25-15-32-31-image.png)

有啦有啦！！！

毫无混淆，流程清晰，ip和管道都看到了

这下可以提交报告了。

初步报告。

因为恶意行为还没分析出来，然后是计划任务也没找到，ip外联做了什么也还不知道

但是起码有成效了。

MEM_052E0000_00025000：读取sys得到的汇编代码

MEM_06350000_00028000：不知道什么时候读取的，大概也是读取sys得到的，dll文件（而非sys文件），在汇编代码中调用。主要恶意文件。

---

下一步应该是直接分析dll就能找到全部了，又是一个新的pe文件，加油吧。

---

# DLL文件分析

---

dll文件外联了一个107.148.73.225的服务器，并且创建了一个命名管道为WF3ss22NHFsnBgfsHDF6

![](/images/fakeapp-dropper/2024-08-25-15-46-40-814d95af76b5bc71271601ab9caef1d.png)

检测了微软杀软、一个pe文件大小为3159603的文件，还有360杀软。

![](/images/fakeapp-dropper/2024-08-25-15-48-37-c05a278e9b6f65325ebb9fcfa5538bf.png)

计划任务找到了：sub_10001D40

![](/images/fakeapp-dropper/2024-08-25-15-49-15-image.png)

如果失败则执行另一个方案：sub_10002440

![](/images/fakeapp-dropper/2024-08-25-15-49-56-image.png)

最末尾的最后一步，唯一调用，有可能是进入等待服务器的阻塞：

![](/images/fakeapp-dropper/2024-08-25-15-50-39-image.png)

因为ida反汇编出来的内容过乱，接下来是随机抽查时间：sub_100018E0

![](/images/fakeapp-dropper/2024-08-25-15-51-41-image.png)

这里的调用链非常糟糕

![](/images/fakeapp-dropper/2024-08-25-15-52-43-image.png)

![](/images/fakeapp-dropper/2024-08-25-15-53-01-image.png)

它在想什么？它想干什么？

这时候应该结合Process Monitor的日志检查了。

UUByte是什么软件？为什么会赢得它单独访问的青睐？

![](/images/fakeapp-dropper/2024-08-25-15-54-33-image.png)

这台电脑上没有Microsoft Drive，看起来有点蹊跷，应该把里面的drive.sys好好拿走分析一下，可能是dll的复制体。

![](/images/fakeapp-dropper/2024-08-25-15-54-26-image.png)

找不到BITS.sys和jerrt.txt，等等，什么txt会放在ProgramData根目录？

![](/images/fakeapp-dropper/2024-08-25-16-03-00-image.png)

好好，还有一个摄像头拍摄，这不会是一个标准的cs马吧？

![](/images/fakeapp-dropper/2024-08-25-16-00-36-image.png)

---

没什么可以分析的了，准备联网，准备恢复快照，直接运行病毒，拿走Drive里面的sys文件。

盲猜是一个被感染的sys文件，只在调用特定api的时候向服务器报告，但是得拿走了才知道。

![](/images/fakeapp-dropper/2024-08-25-16-11-02-image.png)

不会C&C服务器挂了吧，上Monitor！

![](/images/fakeapp-dropper/2024-08-25-16-17-47-image.png)

行？这，也行？看来作者这下真收工了。

看来分析到这里就差不多了。

---

# 收个尾

## 成本最高的一条信息，我早就写下了却没去用

`样本/说明.txt` 里记着一句话：

> 病毒样本文件夹在 `C:\Program Files\Windows Crashpads` 才有效。

正文里那句「没读写关键目录，没创建子进程避免读日志，还真就在睡觉？」，和后来那句「仍然是在读取 Windows Crashpads 里面的 TrackerUI.sys 无限循环不带 sleep」，**是同一件事**。样本按固定路径去找它的伴生文件，路径不对就一直重试。看起来像高明的反分析，其实只是没找到东西。

而我一直到 08-10 才在字符串里「明晃晃」看到这个目录 —— 中间隔了将近一个月。

教训很直白：**已经知道的前提条件，要在动手之前先用掉。**当时它只是一条备注，我没把它当成第一条检查项。

## 这个方法主线，下次直接走

「跟踪就跟踪 buf」是这篇里唯一值得搬走的东西。它出现在 08-20，而我从 07-15 就开始跟了。

它具体是怎么起效的：

1. 别再顺着调用图往下读，**改盯数据** —— 找那块被写进内存、随后又被执行的东西；
2. 断 `memmove(v47, v41, v17)` 的**目标侧**，也就是 `v47` 的读取；
3. `v47` 直接就是可执行指令，而且新建了线程去跑它 —— 到这里解密链就断了；
4. 把 `v47` 的内容和 sys 里的十六进制对比，**不同**，说明中间解过一次密；
5. 回头找解密代码（`v41` 初始化后逐项赋值那段），确认；
6. 单步时盯注释里的 **MZ 字段**，顺着找到可疑内存段，导出。

导出得到的是一个真 DLL（`MZ` + `This program cannot be run in DOS mode.`），而且它**毫无混淆、流程清晰**，IP 和命名管道直接摆在那儿。前面所有费劲的地方都在外壳上，真正的恶意逻辑反而是最容易读的那一层。

## 另外两条，都是否定性的

**别什么都往 IDA 里丢。** `TrackerUI.sys` 拖进去，文件头 `42 8F` 什么都不是。我一度怀疑是"sys 不能这么判"，随手抓了个系统自带的 sys 来对比 —— 结果**系统 sys 也一样**。所以那条路从头就是错的：这个 `.sys` 根本不是 PE，是一个改了扩展名的数据文件（大概率加密，在内存里解）。这个否定性结论值回它花掉的时间。

**杀软的查杀截图不是分析。** 我去卡饭找前人的智慧，翻下来的结论是「都在贴杀软和病毒扫描工具的查杀截图，没人分析」。有效信息我有两条，而这两条我都已经知道了。（顺带，那时候我连卡饭官网都连不上，还怀疑自己进了黑名单 —— 后来发现是我自己的网络问题。）

## 没做完的清单

分析停在外因上：C&C 连不上，作者收工了。所以下面这些是**悬着的**，不是已经解决了的：

- 恶意行为的具体链路（知道有，没跑通）
- 计划任务 `sub_10001D40` 与回退路径 `sub_10002440` 到底注册了什么
- 外联 `107.148.73.225` 做了什么
- `Microsoft Drive\drive.sys` 是不是那个 DLL 的复制体 —— 这台机器上根本没有 Microsoft Drive，这个目录本身就是蹊跷点
- `BITS.sys`、以及 `ProgramData` **根目录**下那个 `jerrt.txt` 为什么在那儿
- 「摄像头拍摄」那条对应什么行为 —— 如果属实，它就不是普通窃密马

样本、明文哈希和复现条件都在仓库里：https://cnb.cool/t1mmoc/tspace/pwngore/h12fakeapp

样本明文不入库，仓里那份是 tagent 签名、用我公钥加密的容器。而**运行条件，就是那句我花了一个月才想起来的话**。
