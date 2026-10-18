---
title: "一个 Delphi 安装包，把载荷藏在文件尾的 tag 流里"
date: 2026-10-16T16:55:00+08:00
lastmod: 2026-10-16T16:55:00+08:00
draft: false
tags: ["恶意样本分析", "逆向", "IDA", "x64dbg", "010 Editor", "Delphi", "zlib", "安装包"]
categories: ["技术笔记"]
description: "一个 Delphi 写的恶意安装包（GUI 标题 快捷[2.7]，落地目录拼错了 Global），把载荷以「长度前缀串 + tag 分派流」的形式追加在自己尾部。在 IDA 里翻不到任何解压代码，因为压缩就是裸 zlib——干活的是 Zlib::TDecompressionStream，而那个看着像数据的 off_45C558 其实是 Classes::TStream::GetSize 的虚表槽。"
---

# 新样本

或者也叫老样本[VirusTotal - File - d95eb625d766c959d7026f3537dc3bf17bb90063cc6480507e6b28bb74a069b6](https://www.virustotal.com/gui/file/d95eb625d766c959d7026f3537dc3bf17bb90063cc6480507e6b28bb74a069b6/details)

以及神秘的东方拼音和东方文字。

![](/images/delphi-installer-dat/2025-03-19-08-39-41-PixPin_2025-03-19_08-39-32.jpg)

![](/images/delphi-installer-dat/2025-03-19-08-41-02-PixPin_2025-03-19_08-41-00.jpg)

![](/images/delphi-installer-dat/2025-03-19-08-40-54-PixPin_2025-03-19_08-40-52.jpg)

# 体验正常安装

反正有快照，作一下

![](/images/delphi-installer-dat/2025-03-19-08-47-08-PixPin_2025-03-19_08-46-41.jpg)

有点看不懂这个软件是干啥的，没有一点提示吗

虽然也有这个程序其实没什么用但是套了个壳子反正都能装一个病毒的想法。

但是病毒究竟是不是这个程序可能还未可知。

也有一种操作是正常安装一个没用的软件，然后真正的病毒悄悄的在其他地方释放。

不管怎么说还是得首先排除这个可能性的

# 追踪安装

![](/images/delphi-installer-dat/2025-03-19-08-53-01-PixPin_2025-03-19_08-52-53.jpg)

用这个可能很low，不过很管用。

![](/images/delphi-installer-dat/2025-03-19-08-55-14-PixPin_2025-03-19_08-55-12.jpg)

啊？真的假的，这么干净的吗？

注册表写入呢？计划任务呢？

不对，可能是这个工具没办法追踪注册表。

![](/images/delphi-installer-dat/2025-03-19-08-58-53-PixPin_2025-03-19_08-58-50.jpg)

对对对个锤子，这是npcap安装包的对比，刚好手头上有个正常的安装包

这病毒也太友好了吧，那我得秒杀它才行。

# 分析

CODE:00460C50 调用，zlib解压并输出到temp目录。

![](/images/delphi-installer-dat/2025-03-19-09-52-13-PixPin_2025-03-19_09-52-09.jpg)

疑似头顶是链表，完成个数标记后底下的是数据。

004650EA：刚完成createfileA读取dat文件（先前已经读取过一次，但那是为了显示窗口）并导出文件

![](/images/delphi-installer-dat/2025-03-19-09-59-11-PixPin_2025-03-19_09-58-51.jpg)

确认主要逻辑代码。

![](/images/delphi-installer-dat/2025-03-21-15-56-56-PixPin_2025-03-21_15-56-34.jpg)

![](/images/delphi-installer-dat/2025-03-21-15-58-37-PixPin_2025-03-21_15-58-35.jpg)

对此我只能说，天啊，这也太善良了吧，指针位置都给我标出来了，我只要拿eax返回值就行了。

太有良心了。

（这里当时看到 VT 上那个 Creation Time `1992-06-19 22:22:17`，第一反应是「不愧是 1992 年就在流通的老病毒」。这句是误读，得改：**Delphi 链接器给它产出的所有二进制都写死这个时间戳**，它既不是真实编译时间也不是上传时间，首次入库其实是 2016-05-27。不过这个假日期反过来看正是 Delphi 的指纹——和 PEiD 报的 `BobSoft Mini Delphi -> BobSoft`、以及后面在 IDA 里撞到的 `TMemoryStream` / `Zlib::TDecompressionStream` / `Classes::TStream::GetSize`，是同一条线索的三种说法。）

sub_460A6C：是否存在下一个文件（while循环条件）

sub_4609C4：读入文件名

sub_460AD4：将文件数据（流）写入到目标文件名中，流到文件名新流。

那么解压缩最有可能发生的地方是：sub_460AD4（参见下图）

![](/images/delphi-installer-dat/2025-03-22-14-00-45-PixPin_2025-03-22_14-00-32.jpg)

不是，全是标准调用？解压缩呢？不会。。。。原样复制吧。

![](/images/delphi-installer-dat/2025-03-22-14-01-43-PixPin_2025-03-22_14-01-42.jpg)

再观察了一遍，不应该，看来是我遗漏了什么，目前最有可能出现问题的是临时流。

没有直接从输入到输出，而是走了一个临时，很有可能这个临时流在输入的时候会自动处理压缩数据。

![](/images/delphi-installer-dat/2025-03-22-14-48-11-PixPin_2025-03-22_14-48-08.jpg)

找到了，临时流竟然是可改的（MemoryStream），在重置的下一个函数。

接下来的步骤是寻找off_45C558是什么初始化参数。

![](/images/delphi-installer-dat/2025-03-22-15-06-12-PixPin_2025-03-22_15-06-09.jpg)

off_45C558并不是一个data数据，是一个指向GetSize的偏移，但对于某些作者而言，指针不在0开始也是有可能的。

翻阅博客：

![](/images/delphi-installer-dat/2025-03-22-15-05-28-PixPin_2025-03-22_15-05-26.jpg)

未见到其需要填入解压的参数，因此off_45C558可能只是编译器结果。

![](/images/delphi-installer-dat/2025-03-22-15-19-10-PixPin_2025-03-22_15-19-09.jpg)

从内存中抓到了压缩的数据和解压后数据，但是这个压缩比有点可疑。

![](/images/delphi-installer-dat/2025-03-22-15-19-41-PixPin_2025-03-22_15-19-38.jpg)

另外注意到71 1B 51开头的数据非常奇怪。

00200200，这是mem_zlib_out2截断的位置，只复制到这个位置。

来源是v10，由sub_419750确定，sub_419750看似是直接从a2读入数据到v10，并且必定读4，但是看流内容又不像，非常奇怪。

# 开始编写代码

感觉读得差不多了，可以开始了。

首先是dat的获取方法，拉到文件尾部，获取的这个长度是压缩后的数据长度。

![](/images/delphi-installer-dat/2025-03-29-20-09-58-PixPin_2025-03-29_20-09-55.jpg)

![](/images/delphi-installer-dat/2025-03-29-20-10-35-PixPin_2025-03-29_20-10-34.jpg)

![](/images/delphi-installer-dat/2025-03-29-20-10-51-PixPin_2025-03-29_20-10-48.jpg)

跳转到的位置在 数据0x39 处，前四个字节是解压后数据长度，然后紧跟着就是压缩后buf。

那么压缩后buf的长度就是0x0026adcf - 8（减去两个长度值）

上代码：
![](/images/delphi-installer-dat/2025-03-29-20-12-10-PixPin_2025-03-29_20-12-05.jpg)

得到的dat文件通过我写的Dat类进行处理，直接附上代码了，解析在上面分析原样本的时候已经给出了。

![](/images/delphi-installer-dat/2025-03-29-20-16-12-PixPin_2025-03-29_20-15-50.jpg)

截图中没有截取到的右边部分和下面部分不重要，右边的是可以通过上下文推断出来的，下面的是测试用例，不重要。

# 收尾

代码在 [cnb.cool/t1mmoc/tspace/pwngore/h24-installer-dat](https://cnb.cool/t1mmoc/tspace/pwngore/h24-installer-dat)，样本和中间产物都以 GPG 容器形式放在里面（明文 PE 不发布）。

能落定的只有两件事：`compress.dat` 的头两字节是 `78 da`，标准 zlib 流头；解出来的 `mem_zlib_out.dat` 头两字节是 `4d 5a`。还有 `compress.dat` 和 `compress-4.dat` 之间正好差 4 个字节——就是解析代码里跳过压缩块时那个 `-4`。

没做完的也留在仓库里：`0x67` 和 `0xC9` 只验到「读掉一个字符串能对齐」，`0x66` 里那四个未知 DWORD 没解，`mem_zlib_out2.dat` 为什么截断在 `00200200`、以及 `sub_419750` 那个「必定读 4 但看流内容又不像」，两个结都没打开。
