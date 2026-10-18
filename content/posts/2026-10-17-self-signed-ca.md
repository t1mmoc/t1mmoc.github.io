---
title: "【AIGC】自建一个 CA，给自己的一堆内网服务签证书"
date: 2026-10-17T16:48:00+08:00
lastmod: 2026-10-17T16:48:00+08:00
draft: false
tags: ["OpenSSL", "CA", "HTTPS", "证书", "内网", "折腾记录", "AIGC"]
categories: ["折腾记录"]
description: "内网里一堆服务要 HTTPS：NAS、frp 面板、noVNC、几个自己写的小后台。每张自签证书都要单独信任一次，换台设备又来一遍——那就自己当 CA，签一次根、永久复用。附 OpenSSL 配置文件的关键三段、SAN 和 EKU 为什么不能省、DNS:*.* 为什么是无效写法，以及一张 10 年的证书在 iPhone Safari 上无声翻车的真实原因（825 天）。"
---

## 起因：手上有一堆半死不活的服务

内网里跑着的东西越来越多了：NAS 的管理页、frp 的 dashboard、noVNC、几个自己写的小后台、偶尔起个文件服务。这些默认都是 HTTP，浏览器地址栏一片"不安全"，而我又懒。

最直接的做法是每个服务自签一张：

```bash
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 365
```

能用。但用着用着就会烦：

- **每张证书都要单独信任一次**。同一个服务的证书一换（换 IP、换域名、重装），浏览器又红一次。
- **手机上是灾难**。十张证书装十个描述文件，设置里翻半天。
- **没法验证链**。每张都是自己签自己，出问题完全看不出来是证书错了还是服务挂了。

而"自己当 CA"这个选项，一开始听起来很重——好像要有 HSM、要有人管私钥、要有审计。实际上**一个 CA 就是一张带 `CA:TRUE` 的证书加一把私钥**，两个文件，一台电脑，半小时。

签一次根，之后所有服务都拿它签。设备只需要信任一次。

## 懒人版：那一页步骤笔记，原样贴

当年把命令记在 CA 目录下一个 `步骤.txt` 里，一字未改，直接抄就能用（前置：目录结构和 `openssl.cnf` 已经就位，造根见后面「第一步」）：

```bash
# 服务器端 生成私钥
openssl genrsa -out crl/server.key 2048

# 服务器端 生成请求
openssl req -new -key crl/server.key -out crl/server.csr -config openssl.cnf

# CA端 批准请求 3650天
openssl x509 -req -in crl/server.csr -CA certs/ca.cert.pem -CAkey private/ca.key.pem -CAcreateserial -out newcerts/server.crt -days 3650 -extensions server_cert -extfile openssl.cnf

# 最终验证（可以跳过）
openssl x509 -in newcerts/server.crt -text -noout

# 吊销证书（没用，自签名服务器）
openssl ca -revoke server.crt -keyfile private/ca.key.pem -cert certs/ca.cert.pem -config openssl.cnf

# 生成新的吊销列表（CRL）（没用，自签名服务器）
openssl ca -gencrl -keyfile private/ca.key.pem -cert certs/ca.cert.pem -out crl/revoke.crl -config openssl.cnf
```

这份笔记本身有两处要留意，后面都有专门小节：`-days 3650` 会让证书在 iPhone 上翻车；最后那两行吊销命令我后来自己标了"没用"，确实没用。

## 先看清目录结构

OpenSSL 的 CA 目录有一套约定俗成的布局，`openssl ca` 那套命令就靠它工作：

```text
ca/
├── openssl.cnf          # 配置：证书模板、默认值、数据库位置
├── index.txt            # 已签发证书的数据库（一行一张）
├── index.txt.attr       # 上面那个数据库的属性
├── serial               # 下一个序列号
├── serial.old
├── crlnumber            # 下一个 CRL 编号
├── certs/
│   ├── ca.cert.pem      # 根证书（要发给别人装）
│   └── ca.cert.srl      # x509 -req 模式下用的序列号文件
├── private/
│   └── ca.key.pem       # 根私钥（命根子，绝不能出门）
├── newcerts/            # 签出来的证书
└── crl/                 # 吊销列表
```

有件事得先说清：**这套目录里一半的文件，我后来根本没用上。**

`index.txt`、`serial`、`crlnumber` 是给 `openssl ca` 那条命令线用的——它会维护数据库、自动分配序列号、能查能吊销。但我实际用的是 `openssl x509 -req`，一条更底层、更直接的命令：拿 CSR + CA 证书 + CA 私钥，签，完事。它不碰数据库，也不写日志。

两套做法没有对错，区别是：

| | `openssl ca` | `openssl x509 -req` |
|---|---|---|
| 要维护数据库 | 要（index.txt / serial） | 不用 |
| 能查/能吊销 | 能 | 不能 |
| 配置成本 | 高（policy、目录结构都得对） | 低（只读扩展段） |
| 适合 | 真的在给别人发证 | 自己用、几张证书 |

我选后者，因为它只依赖一个 `-extfile`。代价就是下面要讲的：**扩展必须手动指定，忘了就是个残废证书**。

## openssl.cnf：真正起作用的只有三段

网上那份 OpenSSL CA 配置动辄两百行，但自用场景下只有三段真正参与：

### 1. `[ v3_ca ]` —— 决定"这是不是 CA"

```ini
[ v3_ca ]
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always,issuer
basicConstraints = critical, CA:true
keyUsage = critical, digitalSignature, cRLSign, keyCertSign
```

这两行是根证书能被操作系统当成 CA 的唯一依据：

- `basicConstraints = critical, CA:true` —— 声明"这张证书可以签发别的证书"。少了它，装进系统也只是个普通证书。
- `keyUsage = critical, ..., keyCertSign, cRLSign` —— 允许用它签证书和签 CRL。少了 `keyCertSign`，链条直接断。

`critical` 的意思是"不认识的实现必须拒绝"，对安全相关的扩展应该加。

### 2. `[ server_cert ]` —— 决定"这张证书能不能当 HTTPS 用"

```ini
[ server_cert ]
basicConstraints = CA:FALSE
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid,issuer:always
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[ alt_names ]
IP.1 = 127.0.0.1
DNS.1 = <你的域名>
```

**这一段是整个流程里最容易漏、漏了最难看的地方。** 尤其 `subjectAltName`——见下一节。

### 3. `[ CA_default ]` / `[ req ]` —— 一堆默认值

```ini
[ CA_default ]
default_md = sha256
policy     = policy_loose

[ req ]
default_bits       = 2048
distinguished_name = req_distinguished_name
x509_extensions    = v3_ca        # 造 CA 时自动套用 v3_ca
```

`default_md = sha256` 是必须的（SHA-1 早就不被接受）。`policy_loose` 是给 `openssl ca` 用的，不用它就不用管。

`x509_extensions = v3_ca` 这一行很关键：它让 `openssl req -x509` 生成的证书自带 CA 扩展。**没有它，造出来的根就是一张没有 `CA:TRUE` 的普通证书**，后面签什么都是白搭。

## 第一步：造根

```bash
# 根私钥，一定要加密
openssl genrsa -aes256 -out private/ca.key.pem 4096
chmod 400 private/ca.key.pem

# 自签根证书，套 v3_ca 扩展
openssl req -new -x509 \
  -key private/ca.key.pem \
  -sha256 -days 7300 \
  -config openssl.cnf \
  -extensions v3_ca \
  -out certs/ca.cert.pem
```

几个决定：

- **`-aes256` 不能省。** 根私钥是这套体系里唯一真正重要的东西：拿到它，别人能给任何域名签证书，而你的设备会全部信任。加密之后至少每次使用要输一次密码。
- **4096 位。** 根证书签一次用十年，多花的那点签名开销摊到十年里可以忽略。
- **`-days 7300`（20 年）。** 根证书过期那天最麻烦——所有由它签发的证书全部失效，得重新造根、重新给所有设备装一遍。20 年是"比我的机器活得久"的保守值。

验证一下根是不是真的成了 CA：

```bash
$ openssl x509 -in certs/ca.cert.pem -noout -subject -dates -ext basicConstraints,keyUsage
subject=C=CN, ST=CN, L=CN, O=TD-Studio, OU=TD-Studio, CN=TD-Studio CA Cert
notBefore=Feb  5 02:21:33 2024 GMT
notAfter=Aug 18 02:21:33 2044 GMT
X509v3 Basic Constraints: critical
    CA:TRUE
X509v3 Key Usage: critical
    Digital Signature, Certificate Sign, CRL Sign
```

看到 `CA:TRUE` 和 `Certificate Sign` 就对了。

## 第二步：签服务器证书

三步，前两步在服务器上做，第三步在 CA 侧做。

**① 服务器自己生成私钥**（私钥永远不离开这台机器）：

```bash
openssl genrsa -out crl/server.key 2048
```

**② 服务器生成 CSR**（签名请求，本质是"我的公钥 + 我想要的身份"）：

```bash
openssl req -new -key crl/server.key -out crl/server.csr -config openssl.cnf
```

**③ CA 侧签发**：

```bash
openssl x509 -req -in crl/server.csr \
  -CA certs/ca.cert.pem -CAkey private/ca.key.pem -CAcreateserial \
  -out newcerts/server.crt -days 3650 \
  -extensions server_cert \
  -extfile openssl.cnf
```

`-CAcreateserial` 会生成 `certs/ca.cert.srl` 记序列号（就是目录里那个文件）。`-extensions` + `-extfile` 这两行是灵魂，缺了它们，签出来的证书**没有 SAN、没有 EKU**。

这三步拆开的意义在于：**私钥从来没离开过服务器，CA 私钥从来没离开过 CA 机器。** 中间流转的只有一个 CSR（公钥 + 身份），被截获了也没用。

## 坑一：没有 SAN 的证书，现代浏览器直接拒

这是整个流程里翻车率最高的一步。

`openssl x509 -req` 是底层命令，**它默认不添加任何扩展**。不加 `-extfile/-extensions`，签出来的证书就只有一个 Subject，没有 `subjectAltName`。

然后 Chrome 打你的站点：

```text
NET::ERR_CERT_COMMON_NAME_INVALID
```

或者 Windows 上更直白：

```text
ERR_CERT_COMMON_NAME_INVALID
证书错误：此服务器的证书中的名称无效或与站点名称不匹配。
```

很多人第一反应是"CN 写错了"。但**CN 早就不是判断依据了**——Chrome 58 起彻底不看 CN，只看 SAN。没有 SAN 的证书，无论 CN 写得多准，一律视为无效。

所以 `[ server_cert ]` 里这两行是生死线：

```ini
extendedKeyUsage = serverAuth
subjectAltName = @alt_names
```

`EKU = serverAuth` 表示"这张证书可以用于 TLS 服务器"。严格说没有 EKU 的证书也常能用，但一旦存在就必须包含 `serverAuth`，所以不如老实写上。

## 坑二：`DNS.1 = *.*` 是无效写法

我一开始图省事，把 `alt_names` 写成了：

```ini
IP.1 = 127.0.0.1
DNS.1 = *.*
```

看着像"匹配一切域名"，实际上不匹配任何域名。

通配符在 X.509 里有一堆限制：

- 只能出现在**最左边那一段**，`www.*.lan` 无效；
- **不能跨标签**，`*.example.lan` 只匹配 `a.example.lan`，不匹配 `a.b.example.lan`；
- 必须**至少有两个标签**，`*.lan` 这种也不能用；
- `*.*` 两个通配符，违反上面每一条。

正确写法是把要用的名字一个个列出来：

```ini
[ alt_names ]
DNS.1 = nas.lan
DNS.2 = *.nas.lan
DNS.3 = localhost
IP.1 = 192.168.1.10
IP.2 = 127.0.0.1
```

想省事的话，把常用内网域名都堆进来，签一张"万能内网证书"复用——反正所有设备都信任你的根，域名和 IP 都可以随手加。**这是自建 CA 相对 Let's Encrypt 唯一真正的优势：不受 90 天和域名验证的限制。**

不过既然写进 `alt_names` 就得手改 cnf，更省事的做法是把这一段单独拿出来：

```ini
# alt_names.cnf —— 每张证书一个
subjectAltName = DNS:nas.lan, DNS:*.nas.lan, IP:192.168.1.10, IP:127.0.0.1
```

签发时 `-extfile alt_names.cnf` 就行，不用动主配置。

## 坑三：`ST=Some-State` 是怎么进去的

我那张服务器证书的 subject 长这样：

```text
subject=C=CN, ST=Some-State, O=TD-STUDIO, CN=<主机名>
```

`Some-State` 不是我想输的，是 OpenSSL 的**默认占位值**。`req_distinguished_name` 里没给 `stateOrProvinceName_default` 的时候，OpenSSL 会用它填空。

它不影响验证（现代校验只看 SAN），但会让 `openssl x509 -subject` 的输出一直很丑。要么在 cnf 里配默认值，要么生成 CSR 时认真填。

顺带说一句：`[ req_distinguished_name ]` 里那些 `countryName_default` 之类的默认值只是提示，回车就用了——**批量签证书时这是效率，随手签一张时这是坑**。

## 验证：别用 `-text` 看，用 `verify`

我原来的步骤文件里，最后一步是：

```bash
openssl x509 -in newcerts/server.crt -text -noout    # 最终验证（可以跳过）
```

这不算验证。`-text` 只是把证书内容打印出来，你自己眼睛看——它不会告诉你这张证书用在某个域名上到底行不行。

真能验证的是这两条：

```bash
# 1. 链能不能走通（本地静态）
openssl verify -CAfile certs/ca.cert.pem newcerts/server.crt

# 2. 服务真的起来了吗、发出来的链对不对、域名匹配吗
openssl s_client -connect 192.168.1.10:443 -servername nas.lan -CAfile certs/ca.cert.pem
```

第二条是唯一"端到端"的检验：它会完成握手、打印服务端实际发出的证书链、并告诉你能不能验证通过。改过 nginx/websockify 配置之后跑一次，比在浏览器里刷十次页面有用。

`openssl s_client` 输出最后一行是 `Verify return code: 0 (ok)` 才算过。

## 让别人信任它：六个地方，六种做法

签出来的证书在自己机器上永远是红的——因为你信任的是"根"，不是"这张证书"。根需要手动装到每个设备的信任库里：

| 平台 | 命令 / 操作 |
|---|---|
| **Windows** | 管理员 CMD：`certutil -addstore -f Root ca.cert.pem`（或双击 → 安装到"受信任的根证书颁发机构"） |
| **Linux** | `cp ca.cert.pem /usr/local/share/ca-certificates/myca.crt && update-ca-certificates` |
| **macOS** | `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ca.cert.pem` |
| **iOS** | 把 .crt 发过去 → 装描述文件 → **再去「设置 → 通用 → 关于本机 → 证书信任设置」里手动打开完全信任**（少这一步等于没装） |
| **Android 7+** | 装"用户证书"只对浏览器生效，**App 不认**。要让 App 信任，要么改系统的 `/system/etc/security/cacerts/`（需 root，文件名是 `<subject_hash_old>.0`），要么在 App 里配 `networkSecurityConfig` |
| **Firefox** | 用自己的 NSS 库，不读系统信任库，得在「设置 → 隐私与安全 → 证书 → 查看证书 → 导入」里单独加一次 |

iOS 和 Android 那两行是"自建 CA 什么时候会突然变得很烦"的全部答案——桌面端一分钟的事，到移动端就变成"文档 + 手动点 + 不确定有没有生效"。

## 那张 10 年的证书，在 iPhone 上无声翻车

我签发时用的是 `-days 3650`。想法很简单：内部服务，谁没事折腾证书。

结果：

- Windows / Chrome / Linux / curl —— 全部正常。
- **iPhone Safari** —— `Safari cannot open the page because it could not establish a secure connection to the server.`

没有细节，没有"继续前往"，没有证书查看器。跟"这个 CA 完全没被信任"的报错一模一样。我一度以为根证书没装好，重装了三遍。

真正的原因在 Apple 的规则里，而且有两条，很容易混：

| 规则 | 适用对象 | 是否管私有 CA |
|---|---|---|
| TLS 服务器证书有效期 ≤ **398 天**（2020-09 起） | 只针对**系统预装**的根 CA 签发的证书 | ❌ 不管。Apple 原文："This change will not affect certificates issued from user-added or administrator-added Root CAs." |
| TLS 服务器证书有效期 ≤ **825 天**（iOS 13 / macOS 10.15，2019-07-01 后签发） | **所有** TLS 服务器证书 | ✅ 管。私有 CA 一样卡 |

也就是说：自建 CA 逃过了 398 天，但没逃过 825 天。3650 天的证书在 Safari 上必然被拒，而 Apple 的 trustd 只是在日志里写一句 `Non-system-trusted leaf validity period longer than 825 days`，界面上什么都不告诉你。

**私有 CA 不等于可以随便填有效期。** 只要你的服务有可能被 Mac 或 iPhone 访问，实际上限就是 825 天——不到两年三个月。签 825 天，或者干脆签 397 天跟公网 CA 一个节奏，把续期练成肌肉记忆。

## CRL 那两行，确实没用

原来的步骤文件里，吊销相关的两条命令后面我自己标了"没用，自签名服务器"：

```bash
openssl ca -revoke server.crt -keyfile private/ca.key.pem -cert certs/ca.cert.pem -config openssl.cnf
openssl ca -gencrl -keyfile private/ca.key.pem -cert certs/ca.cert.pem -out crl/revoke.crl -config openssl.cnf
```

这个判断是对的，原因在于 CRL 的机制：**客户端得知道去哪儿下载吊销列表，才会去检查。** 这靠证书里的 `CRL Distribution Points` 扩展指向一个 URL。私有 CA 没有这个分发点，客户端压根不会去拉——你的 `revoke.crl` 躺在硬盘上，没有任何人看。

OCSP 同理，私有 CA 更不可能跑一个 OCSP 响应器。

所以对自建 CA 来说，**"吊销"这件事的实现方式是：把那张证书从服务上删掉，删掉根（或重新造根）**。机制上粗暴，但有效。

## 顺手多签一种：客户端证书

`openssl.cnf` 里其实还留了一段 `[ usr_cert ]`，是给客户端证书用的：

```ini
[ usr_cert ]
basicConstraints = CA:FALSE
keyUsage = critical, nonRepudiation, digitalSignature, keyEncipherment
extendedKeyUsage = clientAuth, emailProtection
```

签法一模一样，只换扩展名：

```bash
openssl x509 -req -in client.csr \
  -CA certs/ca.cert.pem -CAkey private/ca.key.pem -CAcreateserial \
  -out newcerts/client.crt -days 825 \
  -extensions usr_cert -extfile openssl.cnf
```

这就是双向 TLS（mTLS）的一半：服务端要求客户端出示证书（nginx 里是 `ssl_verify_client on`，加 `ssl_client_certificate ca.cert.pem`），只有拿着你签的客户端证书的人才能连。

对没有账号体系的内网服务，这比配一套登录简单得多——**证书就是身份**。

## 值不值

一次性的成本是半小时：造根、写几段 cnf、把根装到几台设备上。之后签一张证书是三条命令、十几秒。

换来的东西：

- 内网全是绿锁，`curl` 不用 `-k`；
- 想给服务加域名随便加，不用改任何东西；
- 可以做 mTLS，给内网服务加一道"没有证书连不上"的门；
- 顺带把 PKI 那套东西（根 / 中间 / 叶子、SAN、EKU、链验证）从概念变成了手上的文件。

代价也要说清楚：

- **根私钥是你的最高权限。** 它泄漏意味着别人能伪造任何走你这套信任的站点，而且受害者毫无察觉。加密存、别上传仓库、别放进备份同步盘。
- **设备越多越烦。** 四五台还行，二十台就是运维工作了。
- **Apple 的 825 天在那边等着。** 别签十年。

如果只是想给本地开发起几个 HTTPS 服务，`mkcert` 一行命令就搞定了，它会在本地造一个根并自动装进系统信任库——本质和我上面做的完全一样，只是把"装根"这一步也自动化了。

但手搓一遍的价值在于：**你会知道 `mkcert` 到底往你的信任库里塞了什么，以及在它不管用的场合（比如 iOS、比如 mTLS、比如给别人发证书）该怎么办。**

这套东西的目录现在还留在硬盘上，`certs/ca.cert.pem` 二十年后才过期。至于那些 `-days 3650` 签出来的服务器证书，我已经准备把它们全部按 825 天重签一遍了。
