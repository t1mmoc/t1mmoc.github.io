---
title: "【AIGC】用 Rust 写了个 3 FPS 的终端井字棋，AI 最后靠八个特殊局面兜住了"
date: 2026-10-17T16:48:00+08:00
lastmod: 2026-10-17T16:48:00+08:00
draft: false
tags: ["Rust", "crossterm", "游戏", "AI", "终端", "折腾记录", "AIGC"]
categories: ["技术笔记"]
description: "整理旧 IdeaProjects，五个目录里只有两个是自己写的，剩下的都是上游源码快照。自写的那个是 2023 年的 Rust 终端井字棋：crossterm 画框线、3 FPS 的帧循环（注释原话「3帧电竞怎么你了」）、两种输入模式、胜场记在内存里。真正有意思的是电脑对手——不是 minimax，而是四层手写启发式：先查自己能不能赢、再查对方会不会赢、然后一个硬编码八个特殊局面、最后按四条线打分。第三层之所以存在，恰恰说明没有搜索树要付什么代价。顺带记三个小坑：usize 存不了 -1 只能用 4 当哨兵、rand 0.7 的 gen_range(0, 0) 会 panic、以及编译完 82 个警告全来自 camelCase。"
---

## 起因：五个目录，两个是自己写的

`D:\1\MySelf\2025\IdeaProjects` 一共 489 MB，五个目录，**没有一个是 git 仓库**——全是从 GitHub 拖下来的 zip 或纯源码快照。

| 目录 | 性质 | 体积 |
|---|---|---|
| `rustDemo` | 自己写：Rust 终端井字棋 | 147 M（全是 `target/`） |
| `untitled` | 自己写：Java 草稿 | 33 K |
| `KMP-App-Template-main` | 上游模板 | 83 M |
| `compose-multiplatform-master` | 上游仓库快照 | 247 M |
| `localsend-main` | 上游 Flutter 应用 | 13 M |

清掉 `target/`、`.gradle/`、`.idea/`、`out/` 之后 **489 MB → 341 MB**，其中能压的全是 `rustDemo/target`（147 M，三套 profile：`debug`、`release`、`x86_64-pc-windows-gnu`）。

真正自己写的东西不到 2 MB。这篇文章只讲 `rustDemo`。

## 一、结构：分成五个模块

`main.rs` 只有 18 行，做的事是「建一个 `Game`，跑起来」：

```rust
fn main() {
    println!("Hello, world1!");
    let mut game = Game::new();
    game.run();
}
```

剩下的都在 `src/game/` 下：

| 文件 | 行数 | 职责 |
|---|---|---|
| `game.rs` | 233 | 主循环、帧限速、输入校验、胜负判定 |
| `ai.rs` | 177 | 电脑对手 |
| `ui.rs` | 134 | crossterm 清屏 + 框线画棋盘 + 两种输入解析 |
| `scoreBoard.rs` | 27 | 胜场计数 |
| `mod.rs` ×3 | 4 | 模块声明（`ui` 的是空文件） |

`main.rs` 里那个 `Hello, world1!` 一直没删——**这是 `cargo new` 的痕迹，也是这类项目的常态**。它编译完还在打，说明作者从来没在意过这一行。

模块划分是干净的：`game` 管规则和流程，`ui` 管显示和输入，`player::ai` 管对手，`scoreBoard` 管统计。**这个分法比代码本身更值得留下**——后来真正需要改的只有 `ai.rs`，其余三个文件写完就没再动。

## 二、那个 3 FPS 的帧循环

先看代码：

```rust
let fps = 3;                                    // 3帧电竞怎么你了
let frameTime = Duration::from_secs(1) / fps;   // 一个 frame = 333ms
```

然后每回合都走一遍 `tick()`：

```rust
fn tick(&mut self) -> bool {
    let start_time = Instant::now();
    self.print();                               // 画棋盘
    let duration = start_time.elapsed();        // 画完花了多久
    if duration < self.frameTime {
        thread::sleep(self.frameTime - duration);   // 补足到 333ms
    }
    // 等待玩家输入（这一句是阻塞的）
    let playerInput = self.ui.getInput(&self.gameState);
    ...
}
```

这里有个容易被逐帧率迷惑的地方：**它其实不是帧率，而是「每回合的最小间隔」。**

因为 `sleep` 之后紧接着就是阻塞的 `read_line()`——人不下手，程序就停在那里，屏幕上什么都不会重画。`frameTime` 唯一的作用是保证「重画 → 提示输入」之间至少隔 333 ms，让上一帧的棋盘在屏幕上停留一下，而不是闪一下就没了。

`main` 里的玩法也是这个思路：

```rust
loop {
    while self.tick() {}                       // 一局内循环
    println!("按下任意键以进行下一次对战");
    stdin.read_line(&mut inputStr).unwrap();   // 等确认
    self.map = [[0; 3]; 3];                    // 清盘
    ...
}
```

一局打完后 `run()` 不返回，而是直接回到 `loop` 开头再来一把——**这是个不会退出的程序**，只能 `Ctrl+C` 杀。对一个练习项目来说这不算错，反而省掉了「退出的状态怎么管」这一整摊事。

## 三、`usize` 存不了 -1，于是有了哨兵 `4`

解析玩家的坐标时，需要表示「还没设置」。代码是这么处理的：

```rust
pub fn new(inputStr: String) -> Self {
    PlayerInput { inputStr, xIndex: 4, yIndex: 4 }   // usize没办法搞-1，巧的是0我要用
}
```

棋盘是 3×3，合法坐标只有 0、1、2，所以取 4 当越界哨兵。判断合法性：

```rust
pub fn isLegal(&self, map: &[[i8; 3]; 3]) -> bool {
    self.xIndex >= 0 && self.xIndex < 3
        && self.yIndex >= 0 && self.yIndex < 3
        && map[self.xIndex][self.yIndex] == 0
}
```

`self.xIndex >= 0` 对 `usize` **恒为真**——编译器其实会提示这句比较无意义，但不会报错。这半句是多余的，后半句 `< 3` 才起作用。

这个写法是从 Java / C# 迁过来的习惯：那边 `int` 能存 -1，`-1` 是天然的「未设置」。Rust 的正解是 `Option<(usize, usize)>`：

```rust
pub struct PlayerInput {
    inputStr: String,
    loc: Option<(usize, usize)>,
}
// isLegal: self.loc.map_or(false, |(x, y)| map[x][y] == 0)
```

`Option` 强制调用方处理 `None`，而哨兵值不强制——**上面那个恒真的 `>= 0` 就是没被强制的后果**。

## 四、两种输入模式，其实是一个没做完的取舍

开局第一句是问操作方式：

```
您更喜欢哪种操作方式？1:剩余格数法 2:固定位置法(默认)
```

**固定位置法**：九宫格按 1–9 编号，永远不变。

```rust
num -= 1;                     // 输入 1..9 → 0..8
let xIndex = num / 3;
let yIndex = num % 3;
```

**剩余格数法**：只给**空格**从 1 开始编号，落一子整个编号全变。

```rust
// Count 模式：遍历棋盘，遇到空位就计数，和输入对上就落子
for xIndex in 0..3 {
    for yIndex in 0..3 {
        match self.uiMap[xIndex][yIndex].as_str() {
            "O" | "X" => continue,
            _ => {
                countNum += 1;
                if countNum == num { playerInput.setLocation(&xIndex, &yIndex); return; }
            }
        }
    }
}
```

这段代码里藏着一个**没写注释的下溢防护**：

```rust
Ok(mut num) => {
    if num == 0 {                       // 输入 0
        println!("无法解析所输入的内容...");
    } else {
        num -= 1;                       // 先判断再减
        ...
    }
}
```

`num` 是 `usize`，`0 - 1` 在 debug 下 panic（`attempt to subtract with overflow`），release 下变成 `usize::MAX`，然后 `MAX / 3` 和 `MAX % 3` 算出来一个巨大的坐标——`isLegal` 会挡住，但已经绕了一圈。**`if num == 0` 这四行是为了不炸，不是为了提示。**

为什么两种模式都留着？因为各有各的痛点：固定编号需要玩家在脑子里做除法（第 7 格在哪？），剩余格数法每次落子编号全变。当时没想清楚哪个好，就都写了，让玩家自己选——**练习项目最诚实的做法**。

## 五、AI：四层，从便宜到贵

`ai.rs` 的注释开头就一句：`// player 2 always`。电脑永远执 `X`。

`getInput()` 按顺序试四层，前一层命中就返回：

**第一层：我能不能直接赢。**

```rust
for xIndex in 0..3 {
    for yIndex in 0..3 {
        if aiMap[xIndex][yIndex] != 0 { continue; }
        aiMap[xIndex][yIndex] = 2;                  // 试落子
        if let Some(_) = Game::checkWinner(&aiMap) {
            playerInput.setLocation(&xIndex, &yIndex);
            return playerInput;                     // 命中，收工
        }
        aiMap[xIndex][yIndex] = 0;                  // 切回
    }
}
```

**第二层：对方会不会赢。** 同一套循环，只是把 `2` 换成 `1`。这两层加起来不到 40 行，撑住了井字棋 90% 的实战强度。

**第三层：`isSpecialCondition`——硬编码的特殊局面。**

```rust
fn isSpecialCondition(map: &[[i8; 3]; 3]) -> PlayerInput {
    let mut p = PlayerInput::new("".to_string());
    if map[1][1] != 1 { return p; }                     // 玩家没占中心，不管
    if !(map[0][1] == 0 && map[1][0] == 0 && map[2][1] == 0 && map[1][2] == 0) {
        return p;                                        // 四条边中点不全空，不管
    }
    if map[0][0] == 2 {                                  // 电脑占了左上角
        if map[0][2] == 0 && map[2][0] == 0 && map[2][2] == 0 {
            p.setLocation(&2, &2)                        // 就下右下角
        }
    } else if map[2][0] == 2 { ... }                     // 左下 → 右上
    else if map[0][2] == 2 { ... }                       // 右上 → 左下
    else if map[2][2] == 2 { ... }                       // 右下 → 左上
    p
}
```

这段的语义是：**玩家先手占中心、电脑占了一个角、四条边中点还全空时，电脑必须下对角**。四个角各写一遍，一共八行分支。

为什么需要它？因为下面第四层的打分兜不住这个局面——玩家「中心 + 角」是井字棋最强开局，一旦电脑贪了边上的位置，接下来就是一个必输的双威胁。这时候前两层都还没触发（谁都还没二连），第三层是唯一的拦截。

**这八行是这个仓库最值得看的地方**。它说明的不是「作者想到了这个局面」，而是「手写启发式遇到它的天花板之后，只能靠加一层 if 来补」。

**第四层：打分兜底。**

```rust
fn getScore(&self, map: &[[i8; 3]; 3], x: usize, y: usize) -> i32 {
    let mut ret = 0;
    if x == y { ret += 1; }          // 主对角
    if x == 2 - y { ret += 1; }      // 副对角
    // 然后扫这一格所在的四条线（横、竖、两条对角）
    // 线上出现对方的子 → 这条线得分清零；否则累计空位数
    ...
}
```

每个空位算一个分，取最高的那个。逻辑上等价于「优先占对角、其次占空位多的线」——一个很薄的启发式，能让 AI 看起来像在布局。

**这四层合起来，就是一个手工展开的搜索树**：第一、二层是最浅的两层（只看一步），第三层是特判，第四层是评估函数。minimax 用 20 行能表达同样的东西，而且自动覆盖了第三层那种「必须试两步才知道」的局面。这个项目没写 minimax，不是不会，是当时在想「怎么让 AI 别太强」。

## 六、谁先手：一个被 0 坑过的函数

每局换先手，逻辑是「上局谁输谁先手」：

```rust
fn getNextStarter(&self) -> i8 {
    if self.scoreBoard.lastWin == 1 {
        return 2;                                    // 玩家赢之后一定是电脑先
    }
    let max = &self.scoreBoard.p1Win + &self.scoreBoard.p2Win;
    if 0 >= max {
        return 2;                                    // 我服了，平局也会炸
    }
    let r = random.gen_range(0, max);
    if r < self.scoreBoard.p1Win { 1 } else { 2 }
}
```

`rand` 0.7 的 `gen_range(low, high)` 要求 `low < high`，**`gen_range(0, 0)` 会 panic**。而 `max` 是累计胜场——第一局平局之后，双方胜场都是 0，`max` 就是 0。

注释写得非常直接：`// 我服了，平局也会炸`。

这类 bug 的特征是：**边界值不是常量，而是累积状态算出来的**。写的时候脑子里是「打了几局，胜场总是有点数」，实际第一局就可能是 0:0。

顺带说，`gen_range(0, 5)` 这个签名在 `rand` 0.8 之后改成了 `gen_range(0..5)`。`Cargo.toml` 里锁的是 `rand = "0.7.3"`，所以这段代码现在还能编——**但一旦升级依赖，所有 `gen_range` 都要改**。这就是锁版本号能保住「三年后还能编译」的原因。

## 七、82 个警告，全来自 camelCase

`cargo check` 跑完：

```
warning: `rustDemo` (bin "rustDemo") generated 82 warnings
```

82 个里绝大多数是同一句：

```
warning: method `appendWin` should have a snake case name
help: convert the identifier to snake case: `append_win`
```

`scoreBoard`、`getInput`、`lastWin`、`isLegal`、`xIndex`——**整套命名都是 Java / C# 风格**。Rust 只在 `non_snake_case` 这条 lint 上温和提醒，不拦编译，所以一路写下来一个都没改。

这件事的意义不在风格，而在于它标出了迁移的路线：先从 C 系语言过来写 Rust，语法过关了，习惯还留在原地。真正要适应的是三个东西，而这 82 个警告只提醒了最表面的那个：

1. **命名习惯**（被警告了）
2. **错误处理**（`unwrap()` 到处飞，没有一处 `?` 或 `Result` 传播）
3. **所有权**（`&map` / `clone()` / `to_string()` 的分布方式，能看出还处在「想避免借用检查器打架」的阶段）

## 八、回头看，缺的是什么

| 缺的东西 | 现在会怎么做 |
|---|---|
| Minimax + alpha-beta | 20 行替掉第三、四层，且不会漏局面 |
| 单元测试 | 一个 `checkWinner` 的表驱动测试就够；`isSpecialCondition` 值得逐个局面测 |
| 魔法数字 0/1/2 | `enum Piece { Empty, Player, Ai }` |
| `unwrap()` 满屏 | 输入解析用 `?`，或者干脆重问一次 |
| 不退出 | `run()` 返回 `bool`，`false` 就结束 |

但它的分层是对的：**要改 AI 只动 `ai.rs`，要改画法只动 `ui.rs`**。一个周末写出来的练习项目能做到这点，已经比大多数「一个 main 函数写到 800 行」的版本强。

## 收尾

代码整理到了公开仓库：**[cnb.cool/t1mmoc/tspace/rust/rust-ttt](https://cnb.cool/t1mmoc/tspace/rust/rust-ttt)**

源码没改，只补了 README 和 `.gitignore`（忽略 `target/`）。`cargo check` 通过——有 82 个警告，其中一个都没修，因为它们本身就是这个项目要记录的东西。

回头看这一整轮整理，最有意思的数字是那个 489 MB → 341 MB：**30% 的体积、100% 的 `target/`**。编译产物是唯一一种「删掉完全不影响任何东西、而且随时能重建」的数据，而它往往占着项目里最大的那份空间。
