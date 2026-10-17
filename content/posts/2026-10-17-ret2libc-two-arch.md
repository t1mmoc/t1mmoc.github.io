---
title: "【AIGC】ret2libc 折磨了我三天：32 位压栈就完事，64 位卡在一条 pop rdi 和一次栈对齐"
date: 2026-10-17T17:05:00+08:00
lastmod: 2026-10-17T17:05:00+08:00
draft: false
tags: ["PWN", "ret2libc", "CTF", "pwntools", "GOT", "栈溢出", "libc"]
categories: ["技术笔记"]
description: "2023 年 2 月到 3 月，两道 ret2libc 练习把我按在地上摩擦了三天，最后在练习目录里留了一句「完成！我觉得我不会再忘记这个怎么写了」。三年半后把两个样本和脚本归档回看，发现真正卡的和我以为的不是一回事：32 位确实简单（cdecl 参数直接压栈，puts(puts@got) 打出地址字节，偏移 0xa8），64 位难的不是链子本身，是三件和链子无关的事——传参换成寄存器所以必须找 pop rdi; ret、system 里的 movaps 要求 16 字节对齐所以必须垫一条 ret、以及泄漏得靠把 GOT 那 8 字节当格式串打印（地址字节里出现 0x25 就翻车）。另外 pwnme1 里那个 getflag 是条死胡同：它只会 fopen(\"/home/flag\") 然后 perror 走人。附两个架构的对照表、脚本里复查找出来的四处脆弱点，以及现在重写会怎么做。"
---

# 一句话

2023-03-01，我在练习目录里留了一行字：

> 完成！我觉得我不会再忘记这个怎么写了。

三年半后把东西翻出来归档，这句话半真半假。**流程确实忘不掉，但当时卡住我的地方，和我以为的完全不是一回事。**

两个样本、两份脚本，现在一起放在 [ret2libc](https://cnb.cool/t1mmoc/tspace/pwngore/ret2libc)。

---

# 一、为什么这两个目标都必须借 libc

两道题一个 32 位一个 64 位，共同点很明确：**程序里既没有 `system`，也没有 `/bin/sh` 这个字符串。**

那就没得商量了——想拿 shell，只能借 libc 里现成的那两个东西。这就是 ret2libc 的全部动机：**漏洞给你控制流，libc 给你「要执行的代码」。**

两条路的硬件约束还不一样：

| | x86 / pwnme1 | x64 / b |
|---|---|---|
| 保护 | NX **没开**（`PT_GNU_STACK` 是 RWX，栈可执行） | NX **开着** |
| PIE | 否 | 否 |
| Canary | 无 | 无 |

顺手记一条容易被绕进去的：**NX 没开不等于必须写 shellcode。** pwnme1 的栈确实能执行，但栈地址是随机的，你还得先弄到 `jmp rsp`，成功率反而更看运气。借 libc 是确定性的，从头到尾只有「libc 版本」一个变量。

`b` 就更没有选择权了：NX 开着，shellcode 这条路根本不存在。

---

# 二、32 位：一条 `scanf("%s")`，和那个骗人的 getflag

## 程序结构

`pwnme1` 是个菜单题：打印六行水果选项，`scanf("%d", &choice)` 读一个数，然后 `cmp eax, 6; ja default` 走跳转表。选第 5 项（「All not? Input the name」）会进 `getfruit`：

```
0x804865e  lea edx, [ebp - 0xa4]      ← 缓冲区
0x8048663  mov [esp + 4], edx
0x8048667  mov [esp], 0x8048910       ← 格式串 "%s"
0x804866d  call scanf
0x8048670  call printf                ← 再打一遍 "oh,%s...\n"
```

`%s` 不带宽度限制，缓冲区到 `ebp` 是 `0xa4`，加上保存的 `ebp` 是 **`0xa8` = 168 字节**就压到返回地址。

## 程序里那个 getflag 是死胡同

`pwnme1` 有一个 `getflag` 函数，符号都没剥。第一次看到它的时候我以为题做完了：直接 ret 进去不就完事。

它干了什么：

```
printf("Yeah, you got it...\n")
fopen("/home/flag", "r")
if (fp == NULL) { perror("/home/flag"); ... }
fread(buf, 0x78, 1, fp); printf(buf)
```

**它写死了一个本地路径。** 本地跑的时候它只会打印那句恭喜，然后 `perror("/home/flag")`——因为在你的机器上这个文件根本不存在；靶机上 flag 也不在这个位置。

所以这道题的「后门」是一个**看起来能走、实际走不通**的门。这是那三天里最值钱的一课，比任何 gadget 都值钱：

> **函数存在 ≠ 函数能用。** 判断标准是「它拿 flag 的路径在你无法控制的环境里成不成立」，不是「它名字里有没有 flag」。

## 第一段：把 puts 的真实地址打出来

溢出之后不能直接 `system`——不知道 libc 载到哪儿，`system` 的地址也不知道。所以第一段只干一件事：**泄漏。**

```python
payload = b'a' * 0xa8 + p32(puts_plt) + p32(main_addr) + p32(puts_got)
```

这段读法要拆开看，因为它同时用了三种东西：

1. `a*0xa8` 填到返回地址；
2. 返回地址写 `puts@plt` —— 劫持到「调用 puts」；
3. `puts@plt` 的返回地址位置写 `main` —— `puts` 执行完回到主函数，**程序重新活过来**，可以再打一次；
4. 再往后 4 字节是 `puts` 的参数：`puts@got`。

第 4 条是整段的关键。`puts` 要的是 `char *`，你给它的是**GOT 条目的地址**；GOT 里存的是 libc 中 `puts` 的真实地址。于是 `puts` 把那个地址的 4 个字节当成字符串，一路打到高位的 `\0` 为止——**输出里就带着地址本身。**

```python
puts_addr = u32(r.recvuntil(b"\xf7")[-4:])
```

`recvuntil(b"\xf7")` 是个偷懒的截断：32 位 libc 在老 mmap 布局下地址高字节恒为 `0xf7`，所以用 `0xf7` 当终止符。这一段我归档时标成了脆弱点，后面统一说。

拿到 `puts` 的真实地址，减掉它在 libc 里的偏移，就得到 `libc base`：

```python
libc = LibcSearcher('puts', puts_addr)
base = puts_addr - libc.dump('puts')
system = base + libc.dump('system')
binsh  = base + libc.dump('str_bin_sh')
```

当时也写了本地 libc 的备用写法（注释掉的那段 `ELF('/usr/lib/x86_64-linux-gnu/libc.so.6')`）——**两条路各有一个坑**，`LibcSearcher` 依赖本机 libc-database 里有对应版本，本地 ELF 依赖远端和本机是同一版。

## 第二段：cdecl 的舒服之处

```python
payload = b'a' * 0xa8 + p32(sys_addr) + p32(main_addr) + p32(bin_addr)
```

32 位 cdecl：**参数就在返回地址后面依次压着。** 所以 `system` 之后紧跟 `main`（这是 `system` 的假返回地址，占位），再紧跟 `/bin/sh` 的地址（这是 `system` 的真参数）。

原脚本里在末尾垫了 8 个 `a`，注释写的是：

> 最后的 a*8 用来证明 进了 system 函数就不会再回到主函数。

现在看这句话是对的，但理由要补一句：`system("/bin/sh")` 之后你已经在 shell 里了，`system` 要等 shell 退出才 `ret`，那时候假返回地址指向哪儿都无所谓——**`interactive()` 抢在它之前接管了输入输出。**

---

# 三、64 位：链子本身不难，难的是链子之外的三件事

`b` 更干净，整个程序只有十行有效逻辑：

```
main:   setvbuf, printf("请输入："), call readit
readit: read(0, rbp-0x20, 0x64)      ← 100 字节读进 32 字节缓冲
        printf("hello %s", buf)
```

偏移 = `0x20` + 保存的 `rbp` 8 字节 = **`0x28` = 40**。

溢出点比 32 位那道还简单，但真正耗时间的是下面三件事——**它们和「链子怎么排」没有关系，却能让一条完全正确的链子直接崩在你脸上。**

## 坑一：参数换成寄存器，所以必须先找一条 gadget

32 位你可以在栈上摆参数。64 位不行了：第一个参数走 `rdi`，第二个 `rsi`，第三个 `rdx`。栈上摆得再整齐，`rdi` 里没有值，`system` 拿到的就是垃圾。

所以 64 位 ret2libc 的第一步不是写 payload，是**在程序里找一条 `pop rdi; ret`**。这道题的 `b` 里没有现成的，最后用的是 `__libc_csu_init` 尾巴上的：

```
0x400713   5f        pop rdi
0x400714   c3        ret
```

（`__libc_csu_init` 从 `0x4006b0` 开始，长 101 字节，正好在 `0x400715` 结束，这两字节就是它的收尾。）

**这一步是 64 位和 32 位最本质的差别**，也是为什么 64 位的题一上来就要 `ROPgadget`：不是链子复杂了，是「怎么把参数送进去」这件事本身成了要解决的问题。

## 坑二：栈对齐——地址全对也照样崩

这条坑了最久，因为它**没有任何报错信息指向对齐**。

现象是：泄漏成功、base 算出来了、`system` 和 `/bin/sh` 的地址都打印出来核对过、payload 拼得一字不差，一跑——`SIGSEGV`，而且崩在 libc 里面，不在你的 payload 上。

原因在 `movaps`：`system` 内部有一句 `movaps [rsp+x], xmm0` 类的指令，要求操作数 **16 字节对齐**。函数被 `call` 进去时栈顶应该是 `rsp % 16 == 8`（`call` 压了一个返回地址，把 16 字节对齐的栈打偏了 8）。我们用 `ret` 链跳进去，`ret` 弹一次只加 8 字节，栈的相位就靠运气——乱了就是 `SIGSEGV`，而且崩的地方离你写错的地方很远。

解法土得不能再土：**在链子最前面多垫一条 `ret`。**

```python
payload = b'A' * 0x28 + p64(ret) + p64(pop_rdi) + p64(bin_sh) + p64(system) + b'a' * 8
```

`ret` 什么都不做，只是把栈再抬 8 字节，把相位摆回去。脚本里的 `ret_addr = 0x004004ce` 就是从这个二进制里挑的一条孤零零的 `c3`（在 `.plt` 之前、`0x4004d0` 之前的空隙里）。

**记成一句话：64 位链子跑不通，先怀疑对齐，再怀疑地址。** 顺序反了会浪费很多时间，因为地址往往是对的。

## 坑三：泄漏这一步，两种写法只能活一种

`b` 里只有 `printf` 和 `read`，没有 `puts`，所以不能照抄 32 位那套。当时写的是：

```python
printf_plt = 0x4004E0
printf_got = elf.got['read']          # 变量名叫 printf_got，装的其实是 read@got
...
payload = ... + p64(rdi_ret) + p64(printf_got) + p64(printf_plt) + ...
```

变量名和内容是错开的——这是照模板改代码留下的物证，值得原样保留。

关键是它为什么能工作：`printf` 的第一个参数是**格式串**，你传的是 `0x601020`（`read@got` 的地址）。`printf` 于是把 GOT 里那 8 个字节**当成格式串来解析**，而那 8 个字节正是 libc 中 `read` 的地址：低 6 字节是有效地址，高 2 字节是 `\0`，字符串到此为止。**输出就是地址本身。**

```python
printf_addr = u64(p.recvuntil("\x7f")[-6:].ljust(8, b'\x00'))
```

这条路有一个隐患值得单独标出来：**地址字节里一旦出现 `0x25`（`%`），`printf` 就会把它当格式符开始解析**，轻则输出错位、重则直接崩。32 位那种「把 GOT 交给 `puts`」的写法没有这个问题，因为 `puts` 不解析格式符。

所以同样的意图，两种函数两种风险：

| 写法 | 原理 | 风险 |
|---|---|---|
| `puts(puts@got)` | `puts` 把 GOT 内容当字符串打印 | 地址含 `\n` 会提前截断 |
| `printf(fmt = GOT地址)` | 把 GOT 内容当格式串打印 | 地址含 `0x25` 会被解析 |

---

# 四、两个架构摆一起

| 项目 | x86 / pwnme1 | x64 / b |
|---|---|---|
| 返回地址偏移 | `0xa8` | `0x28` |
| 参数怎么传 | cdecl，直接压栈 | `rdi`，必须先有 gadget |
| gadget 需求 | 无 | `pop rdi; ret`（`0x400713`） |
| 栈对齐 | 不用管 | 必须垫一条 `ret` |
| 泄漏函数 | `puts(puts@got)` | `printf(read@got)` |
| libc 定位 | `LibcSearcher` / 本地 ELF | 本地 `libc.so.6` |
| 第二段的假返回 | `main` | `main` |
| 两段式的原因 | 第一次只为泄漏，回 `main` 重来 | 同左 |

规律很清晰：**32 位的难点在「找 libc 版本」，64 位的难点在「送参数 + 对栈」**。前者是信息问题，后者是工程问题。

---

# 五、归档时复查找出来的四处脆弱点

脚本原样留着没改，但我在 README 里把这四条记下来了，因为它们是「能跑」和「可复用」的差距：

1. **`recvuntil(b"\xf7")` 依赖 32 位 libc 地址高字节恒为 `0xf7`。** 老内核的老布局才成立，换版本或换地址空间布局就截错。稳一点是按固定长度 `recv(4)`。
2. **`printf(GOT地址)` 有 `0x25` 风险**（见上）。
3. **libc 版本靠猜。** `LibcSearcher` 是本机数据库匹配，本地 ELF 是假设远端同版本。这两条都不算「知道」，只算「试」。
4. **栈对齐是硬编码的。** 那条 `ret` 垫片是按当时那版 libc 调出来的，换 libc 可能要重调。

第 3 条是 ret2libc 这类题永恒的不确定性：**漏洞是确定的，libc 是不确定的。** 所以正式比赛里，题要么给你 `libc.so.6`，要么让你泄漏两个函数算差值。没有第三条路。

---

# 六、现在再写，我会这么做

顺序比技巧重要：

1. **先看保护，再决定路线。** NX + 无 PIE + 无 Canary → 典型 ret2libc/ROP；有 PIE 就得先泄漏代码基址；有 Canary 就得先泄漏 canary。
2. **先确认程序里有没有 `system` 和 `/bin/sh`。** 有就直接 ret2text，一分钟的事，别急着搭 libc。
3. **泄漏统一用 `puts(GOT)`**，除非程序里没有 `puts`——那才轮到 `printf` 当格式串这种偏方。
4. **链子跑不通，按「对齐 → gadget 地址 → libc 版本」的顺序查**，别一上来就改 payload。
5. **两段式是标准动作**：第一段只泄漏，返回 `main`；第二段才 getshell。别想着一次搞定。
6. **把 libc 版本这件事当成一等公民**，要么题目给，要么用 libc-database 匹配，要么泄漏两个函数算差值。

至于 pwntools，现在它有 `ROP` 和现成的 ret2libc 模板，能省掉找 gadget 的大部分体力活。但省掉的是体力，不是理解——**这次回看最清楚的一点就是：当年真正卡住我的，没有一处是 pwntools 能替我解决的。**

---

# 收尾

三条，按重要性排：

1. **程序里有个叫 getflag 的函数，多半不是给你用的。** 判断它能不能用，看它拿 flag 的路径在你控制不了的环境里成不成立。
2. **64 位 ret2libc 的失败，八成不是链子写错，是栈没对齐。** 先垫一条 `ret`，再怀疑地址。
3. **ret2libc 的确定性只到「漏洞」为止，libc 版本永远是不确定项。** 拿到 libc 就是算术题，拿不到就是概率题。

样本、两份脚本（原样，未美化）和这些地址表都在仓库里：

**<https://cnb.cool/t1mmoc/tspace/pwngore/ret2libc>**

有问题随时问。
