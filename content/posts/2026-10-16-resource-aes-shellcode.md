---
title: "一个 x64 样本的资源里，藏着 PowerShell 下载器和一段 32 位 shellcode"
date: 2026-10-16T17:25:00+08:00
lastmod: 2026-10-16T17:25:00+08:00
draft: false
tags: ["恶意样本分析", "逆向", "IDA", "x64dbg", "PowerShell", "AES", "shellcode"]
categories: ["技术笔记"]
description: "一个 x64 样本把加密的 PowerShell 下载器塞进 PE 资源（ID 84，长度 0x6AB）。资源原地解密后是一段脚本：从 ph4nt0m.fr 取 c.aes，用 AES-256-CBC、Padding=None 解出 103,936 字节——不是 PE，是 32 位 shellcode。能确定密文和明文等长、且长度正好块对齐，由此反推填充方式。没解出来的是密钥从哪来。"
---

# 新样本

又是资源解密类型的样本，看看ida

![PixPin_2025-05-08_11-17-22](/images/resource-aes-shellcode/PixPin_2025-05-08_11-17-22.jpg)

哦？64位的样本，罕见。



根据提示，寻找加密内容

![PixPin_2025-05-08_11-23-36](/images/resource-aes-shellcode/PixPin_2025-05-08_11-23-36.jpg)

84是最大的，长度为6AB。

断一下loadResource，检查长度为6AB的资源读入。由于手比较快，没有记录下来。

ida跟随，得到程序包装的loadRes+resSize+malloc+memcpy一套组合拳

![PixPin_2025-05-08_11-24-39](/images/resource-aes-shellcode/PixPin_2025-05-08_11-24-39.jpg)

获取v5，然后断v5的内存。

![PixPin_2025-05-08_11-25-46](/images/resource-aes-shellcode/PixPin_2025-05-08_11-25-46.jpg)

读写命中，ida跟随。

![PixPin_2025-05-08_11-26-22](/images/resource-aes-shellcode/PixPin_2025-05-08_11-26-22.jpg)

这个子函数，有点像解密函数？

啊？就结束了？有点突然啊

不急着惊喜，先检查一下解密后输出的是啥，确定一下先

![PixPin_2025-05-08_14-55-08](/images/resource-aes-shellcode/PixPin_2025-05-08_14-55-08.jpg)

本来想着先跳到解密后的内容，再查看输出到哪里的，结果是原地输出。

![PixPin_2025-05-08_14-56-26](/images/resource-aes-shellcode/PixPin_2025-05-08_14-56-26.jpg)

最底下存在一些指针数据，但一起打包输出好了。

> 解密是原地输出的，直接把那块内存整段打出来就是 `data.bin`（1,792 字节）。它属于明文载荷，不放在这里，在仓库的加密容器里：[h31-resource-restore](https://cnb.cool/t1mmoc/tspace/pwngore/h31-resource-restore)。



懒得看了，直接丢ai，然后才发现这流程简单得很，根本不需要给ai分析，还可能因为ai泄露相关信息。

好消息：下载是正常的，101kb

坏消息：解密后不是一个pe文件，是一段shellcode，无法使用f5分析。

![PixPin_2025-05-08_15-18-08](/images/resource-aes-shellcode/PixPin_2025-05-08_15-18-08.jpg)

一个64位的程序居然下载了一个32位的shellcode（因为右边的代码执行到0009就会报错了，而且异常杂乱。）

然后左边的shellcode存在大量的数据，只有少量代码，可能还要接着解密。

# 解密相关

第一步解密密钥：A2875F380C85A4268928FBF8757C270C

第二步ps脚本密钥到shellcode的密钥是这个：
$k_b64 = "wqxFlosWJ4+C/zJFPOuo+TsjUNtRJl+2Eqef7OP4kJ0="
$iv_b64 = "QC+ioLNFD72DhX8D9aA5fQ=="

# 回顾



![PixPin_2025-05-08_16-04-04](/images/resource-aes-shellcode/PixPin_2025-05-08_16-04-04.jpg)

> 此事在《9带脚本的安装包逆向》中亦有记载

# 解密的密钥从何处来

> A2875F380C85A4268928FBF8757C270C

![PixPin_2025-05-09_14-34-03](/images/resource-aes-shellcode/PixPin_2025-05-09_14-34-03.jpg)

断头顶，找free

指针：0x14001E4BC->0x0000000002224940=str

断下指针malloc获得内存区域，断内存区域找到copy函数

![PixPin_2025-05-09_14-43-37](/images/resource-aes-shellcode/PixPin_2025-05-09_14-43-37.jpg)

往前一个堆栈寻找。

使用硬件断点直接深入到最底层寻找，返回到用户代码，找到目标循环。

![PixPin_2025-05-09_15-00-21](/images/resource-aes-shellcode/PixPin_2025-05-09_15-00-21.jpg)

重要函数：000000014000FB10，传入的参数是这样的：

![PixPin_2025-05-09_15-06-31](/images/resource-aes-shellcode/PixPin_2025-05-09_15-06-31.jpg)

![PixPin_2025-05-09_15-06-50](/images/resource-aes-shellcode/PixPin_2025-05-09_15-06-50.jpg)

![PixPin_2025-05-09_15-07-00](/images/resource-aes-shellcode/PixPin_2025-05-09_15-07-00.jpg)

也就是说，把这部分内容变成了，ascii大写。

因此还得查a1的来源。



![PixPin_2025-05-09_15-11-47](/images/resource-aes-shellcode/PixPin_2025-05-09_15-11-47.jpg)

找到关键函数sub_14000F68C

传入参数：

a1：0000000002311DA4->（如下图所示，多框选了两个，只到10）

![PixPin_2025-05-09_15-16-33](/images/resource-aes-shellcode/PixPin_2025-05-09_15-16-33.jpg)

a2：000000000014FDD8->0x40

a3:0x8

![PixPin_2025-05-09_15-15-42](/images/resource-aes-shellcode/PixPin_2025-05-09_15-15-42.jpg)

以及辅助函数sub_14000EE20如下：

![PixPin_2025-05-09_15-18-18](/images/resource-aes-shellcode/PixPin_2025-05-09_15-18-18.jpg)

或者改成：

调用了辅助函数sub_14000EE20，调用参数：

a1：0000000000B61DA4，1-ef-fe-1，上面图片有了不再赘述，没有任何修改。

a2：如图所示。

![PixPin_2025-05-09_15-24-32](/images/resource-aes-shellcode/PixPin_2025-05-09_15-24-32.jpg)

另外，a2其实就是a1+24，完整的截图是这样的：

![PixPin_2025-05-09_15-34-05](/images/resource-aes-shellcode/PixPin_2025-05-09_15-34-05.jpg)