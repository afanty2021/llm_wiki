# 同 URL 双路径媒体分发（校内直连 / 校外隧道）设计 spec

- **日期**：2026-09-05（spec）/ 2026-09-06（实施）
- **状态**：**已实施并验证**（三轮评审：spec 评审 Approve with fixes 488c7574 → Phase A/B 部署评审 with fixes 收口；实施态勘误与验证记录见 §10）
- **背景**：教师视频播放当前全部经 Cloudflare 隧道（免费层无带宽计量，但条款对"大量视频分发"有裁量限制）；规模化后校内直连可同时解决带宽政策与播放体验（seek 延迟）。

---

## §0 现场事实（全部一手核验，2026-09-05）

| 事实 | 值 | 核验方式 |
|---|---|---|
| 域名 NS | Cloudflare（nikon/joan.ns.cloudflare.com） | dig |
| Mac 内网地址 | 192.168.2.88/24，**DHCP 保留已做**（用户确认） | ifconfig + 用户 |
| Mac 网络 | 有线，常驻机构网 | 用户确认 |
| 网关（XVR1800） | 192.168.2.1 | route get default |
| LAN 当前 DNS（DHCP 下发） | 首选 114.114.114.114 / 备用 119.29.29.29 | 本机 Chrome 实测路由器页 |
| TL-XVR1800 本地 DNS 覆盖 | **无——2026-09-05 本机浏览器实测证实**：DHCP 服务页仅"缺省域名"（option 15 域后缀，非解析记录）；LAN 区 8 标签页与全部 9 个菜单组均无本地域名/DNS 记录/自定义解析功能 → 走 dnsmasq 分支的直接原因 | 浏览器直查管理界面 |
| Mac 443 / UDP 53 | 均空闲 | lsof |
| 隧道公网面 | path 白名单 `^/(t\|s\|media)/.*$\|^/health$`（SEC-5），管理面仅本机 | ~/.cloudflared/config.yml 现文 |
| src-server | 绑 127.0.0.1:8080，**本方案不改** | launchd plist |

## §1 目标 / 非目标

**目标**：同一 URL `https://api.xiaoluedu.top`——校内 Wi-Fi 直连 Mac（不占隧道、内网速度、seek 跟手），校外/蜂窝自动走隧道。教师零感知（链接、企微、周报全不变），零客户端。
**非目标**：不替代隧道（校外仍需）；不动 src-server/cloudflared/企微/Hermes；不给教师任何配置动作。

## §2 架构

```
校内：手机 → DHCP DNS（主 192.168.2.88）
        → 命中 api.xiaoluedu.top → 192.168.2.88（dnsmasq 唯一覆盖条目）
        → Caddy :443（TLS 终止，LE 证书）→ path 白名单 → 反代 127.0.0.1:8080
      其余域名 → 转发上游 114.114.114.114 / 223.5.5.5（行为与现状同）
校外：公网 DNS → CF 边缘 → cloudflared → 127.0.0.1:8080（现状不变）
降级：主 DNS 不可达 → 客户端自动用副 DNS 114.114.114.114 → 回落隧道（=现状）
```

## §3 组件规格

### 3.1 dnsmasq（LAN DNS，唯一覆盖一条）
- `brew install dnsmasq`；配置（/opt/homebrew/etc/dnsmasq.d/ltutor.conf，或主 conf include）：

```conf
# 只监听内网接口，不碰 lo0（避免与 mDNSResponder 纠缠）
listen-address=192.168.2.88
bind-interfaces
no-resolv
# 上游 = 现网已用的公共解析（主备），行为与现状一致
server=114.114.114.114
server=223.5.5.5
# 唯一覆盖条目：本方案全部意义所在
address=/api.xiaoluedu.top/192.168.2.88
cache-size=1000
# 不开 log-queries（隐私）；启动/错误日志走 launchd stderr
```

- launchd `wiki.dnsmasq`：RunAtLoad + KeepAlive，ExecStart `/opt/homebrew/opt/dnsmasq/sbin/dnsmasq --keep-in-foreground --conf-file=<上述>`；**系统级 LaunchDaemon（644）——UDP53 特权端口须 root 绑定**（LaunchAgent EPERM 实测，实施期发现；dnsmasq root 起后自降权 nobody）。conf 实际安装位 `/opt/homebrew/etc/dnsmasq-ltutor.conf`。
- **Mac 自身 resolver 实施态勘误**：spec 原文"保持 114 不变"已被 Phase C 打破——en7 续租后 Mac 经 DHCP 拿到主 .88/副 114，`api.xiaoluedu.top` 在本机解析为 192.168.2.88（经 caddy 直连，本地开发不受影响：127.0.0.1 直连路径不经过 DNS；cloudflared 连边缘不依赖该域名解析）。

### 3.2 Caddy（LAN TLS 终止 + 白名单反代）
- 官方 custom build 带 `caddy-dns/cloudflare` 插件（caddyserver.com 下载 API；下载后 **sha512 校验**记录进 runbook）。

```caddyfile
https://api.xiaoluedu.top {
    bind 192.168.2.88          # 只绑内网；回环/公网面不变
    tls {
        dns cloudflare {env.CF_DNS_TOKEN}
    }
    # 白名单逐字照抄隧道 SEC-5：LAN 暴露面 = 公网暴露面
    @allowed path_regexp ^/(t|s|media)/.*$|^/health$
    handle @allowed {
        reverse_proxy 127.0.0.1:8080
    }
    handle {
        respond 404
    }
    log {
        output file /var/log/caddy-lan.log
        # 直连流量的唯一可观测来源（axum 侧两路径都是 127.0.0.1，无法区分）
        # 实施态勘误：v2.11 file 输出默认滚动（roll 子指令已不存在）；路径由 ~/Library/Logs 迁 /var/log（评审 M1）
    }
}
```

- launchd `wiki.caddy-lan`：**系统级 LaunchDaemon**（TCP443 特权端口须 root 绑定，实施期发现，见 §10）；KeepAlive；env 只放 `CF_DNS_TOKEN`；plist 600，模板入仓。

### 3.3 Cloudflare API Token
- 权限：**Zone → DNS → Edit，Zone resources 限定 xiaoluedu.top 单 zone**。
- 泄漏最坏影响 = 该域 DNS 可改（域劫持）→ 按既有密钥纪律（plist 存放、可随时在 CF dashboard 撤销、有使用审计）。

### 3.4 路由器改动（唯一网络侧变更）
- XVR1800 → 基本设置 → LAN 设置 → DHCP 服务页（实测确认字段）：**首选 DNS 服务器 `114.114.114.114` → 改 `192.168.2.88`；备用 DNS 服务器 `119.29.29.29` → 改 `114.114.114.114`**（现主值降为副值，语义不变）。
- 备用 DNS 是本方案的关键降级设计：dnsmasq 挂/Mac 关机时，客户端按 resolver 回退语义自动用副 DNS → 域名回到公网解析 → 走隧道 = **降级为现状，而不是断网**。
- 既有 DHCP 租约在续租/重连后生效（新接入设备立即生效）；实测地址池 192.168.2.30-254。**租期实测勘误（评审 M4）：getpacket 实收 lease_time 0x15633984 ≈ 11.4 年**（路由器页面配置的"180 分钟"与实际下发不符，固件行为）——sticky 设备不重连则不切 DNS，切换/回滚依赖重连或手动 renew，"≤180min 全网切换"不成立。

## §4 失败模式

| 故障 | 表现 | 语义 |
|---|---|---|
| dnsmasq 挂（KeepAlive 秒拉） | DNS 查询主超时 → 副应答（慢 ~秒级） | **降级为现状（隧道）**，不断网 |
| Mac 整机 down | 教师服务全灭（src-server/隧道/网关都在它上） | 与现状同构，非新增 |
| Caddy 挂/证书续期失败 | **校内**打开链接失败（DNS 已指向本机，不会自动回落）；校外正常 | KeepAlive + LE 自动续期（提前 30 天）；runbook 口径：校内打不开→关 Wi-Fi 走蜂窝即隧道 |
| 路由器 DHCP 改动被回退 | 全员回隧道 | 无害 |
| 办公设备（DNS 视角） | Mac down 后首个 DNS 查询付 ~2-5s 超时再回退副 DNS；resolver 记住死服务器后恢复常速 | 过渡期一至数次查询变慢，非教师服务单点（评审 ③ 补：仅教师服务视角「与现状同构」，DNS 视角不同构） |
| **将来开启 IPv6** | RDNSS/RA 下发的 v6 DNS 将**旁路** DHCPv4 的 DNS 覆盖 | 实测 en0 当前零 inet6，本 LAN 无 v6，风险不成立；**开 v6 前须重审本方案**（评审 ③） |
| iPhone Private Relay | 该教师解析走 Apple 中继 → 直接走隧道 | 自动回落=现状，无害 |
| 租约未续的设备（新旧 DNS 并存窗口） | 部分走隧道部分直连 | 双路径同时有效，无害 |
| **手动写死 DNS 的设备**（不走 DHCP） | 不吃路由器 DNS 变更——继续公网解析走隧道 | 可用但不直连；存量设备边界（C.4 随察 ③；2026-09-06 跟进修 Minor 补录，兑现 §10 台账承诺）；改直连须手动改其 DNS 或恢复自动获取 |

唯一新增不可用面 = Caddy 行（直连路径自身故障时校内无自动兜底）——这是 DNS 覆盖式方案换零客户端的固有代价。

## §5 安全面

- LAN 暴露面 = 公网面（同一条 path 白名单）：`/api/v1/*`（login/bind/overview/logs）与管理面在 LAN 同样不可达。LAN 暴露面的实际防护 = **媒体 HMAC（三段签名 + fp 绑定 + 30d 窗）+ 短码不可猜 + `/t/` 公开设计**——与公网面完全同一组防线。（评审 ① 修正：`/s/`/`/t/` 的既有限流按短码/plan 身份计桶、非 per-IP，不构成来源侧防线，不在此引为防护依据。）
- dnsmasq 暴露 = 内网任意设备可查询（纯转发 + 一条覆盖，无敏感数据）；不监听公网/WAN。
- 新增密钥资产：CF_DNS_TOKEN（单 zone DNS:Edit）。
- 非教师办公设备影响：DNS 路径从 114 直连变为经 Mac 转发至 114（延迟 +≈1ms，Mac down 时回退）。

## §6 分阶段实施与验证（每阶段独立可回滚）

**Phase A — dnsmasq（零网络影响）**
1. brew install；写 conf；launchd 起。
2. 断言：`dig @192.168.2.88 api.xiaoluedu.top` → 192.168.2.88；`dig @192.168.2.88 baidu.com` → 真实 IP（经上游）；`dig @114.114.114.114 api.xiaoluedu.top` → 公网 IP（旁路未受影响）。
3. 回滚：bootout wiki.dnsmasq。

**Phase B — Caddy + 证书（零网络影响，不动路由器）**
1. 下载带插件的 caddy（sha512 校验）；CF 建 token；Caddyfile + launchd。
2. 断言（本机）：`curl --resolve api.xiaoluedu.top:443:192.168.2.88 https://api.xiaoluedu.top/health` → 200；`/s/某真短码` → 303；`/media/...`（带合法票据）→ 206；`/api/v1/auth/login` → **404**（白名单外）。
3. 回滚：bootout wiki.caddy-lan。

**Phase C — 路由器 DHCP 主/副 DNS（生效点）**
0. **step 0 前置闸门（评审 ②）**：核路由器可同时下发主+副两条 DNS——**已双证据闭环**（2026-09-05 路由器 DHCP 服务页实测两字段并存有值；Mac `scutil --dns` 实收 nameserver[0]=114.114.114.114 / nameserver[1]=119.29.29.29 两跳均来自 DHCP 下发）。若固件升级后只剩单条 DNS 字段，方案**止步 Phase B**（直连仅手动配置设备可用，不推全网）。
1. XVR1800 改 DHCP DNS = 主 .88 副 114。
2. 真机校内 Wi-Fi：打开一条真实 `/s/` 短链全链（303→落地→播放→完成 beacon）；`tail caddy-lan.log` 见记录 = 直连实锺；同一码流拖动 seek 正常。
3. 蜂窝网络真机同一链接 → 隧道全链 + cloudflared 无异常（回归）。
4. 办公设备抽查：正常上网 + `nslookup api.xiaoluedu.top` 经 .88。
5. 回滚：路由器 DNS 字段改回 114 / 119 后，**已连设备因超长租约（见 §3.4 勘误）不自动切回**——重连 Wi-Fi 或手动 renew 即切；粘滞设备期间直连路径仍可用（daemon 在跑），要立即全网回隧道则停两 daemon（粘滞设备主 DNS 超时 ~1s 后回退副 114，即降级路径）。

## §7 观测与运维

- 直连流量：caddy-lan.log（file 输出默认滚动）；隧道流量：cloudflared/现有日志不变。
- runbook（m3-gray-runbook.md）增补"媒体分发双路径"一节：架构一句话、故障口径（校内打不开→切蜂窝）、回滚三步、证书/token 资产位置。
- 上线后观察一周：双路径 206/429 比例、caddy 进程存续、dnsmasq 存续（KeepAlive 计数）。

## §8 成本与增量

全免费（dnsmasq/Caddy 开源、LE 证书、无 CF 套餐变化）。新增长期面：2 个 launchd 服务 + 1 个 CF token + 路由器 DNS 字段。实施约半天（含真机验证）。

## §9 风险与开放项

1. Caddy custom build 供应链：官方下载 API + sha512 校验 + 版本钉住（记录进 runbook）。
2. 主副 DNS 回退语义依赖客户端 resolver 行为（iOS/Android 均支持多 nameserver 超时回退）——Phase C 用"临时 bootout dnsmasq + 真机还能上网"实测一次降级。
3. Caddy 故障时校内无自动兜底（§4 已述）——接受，靠 KeepAlive + 口径。
4. 本方案不解决校外流量的隧道依赖与条款裁量（那部分仍是现状；若将来校外视频流量也需分流，属另一个方案：R2/Stream，不在本 spec 范围）。

---

## §10 实施与验证记录（2026-09-06 收口，含 Phase A/B 部署评审随批修订）

三阶段全部落地。评审报告：`.superpowers/lan-phase-ab-review-2026-09-06/`（with fixes）。

### 实施事实与勘误

- **特权端口（spec/评审共同盲点，实施期实测）**：UDP53 与 TCP443 均 <1024 须 root——两服务均为系统级 LaunchDaemon（`/Library/LaunchDaemons/`，launchctl system 域）；dnsmasq root 起后自降权 nobody；Caddy 无自降权，接受 root（仅 bind 192.168.2.88，admin endpoint 已 off 缓释）。
- **Caddy v2.11 语法**：file 输出默认滚动（`roll` 子指令已不存在）；`{ x }` 内联块非法。
- **随批修订已生效（评审 M1-M3）**：访问日志迁 `/var/log/caddy-lan.log`（root:600，tail 需 sudo，与 daemon 运维同域）；`admin off`（原 127.0.0.1:2019 root 监听已关，复验 refused）；dnsmasq `log-facility=-`（err.log 原恒 0 字节，现有启动行）。
- **租期勘误（M4）**：DHCP 实发租约 ≈11.4 年（页面"180 分钟"与实际不符）——切 DNS/回滚依赖**重连或手动 renew**，非"≤180min 全网切换"（§3.4/§6.C.5 已改写）。
- Mac 自身 resolver 已随 Phase C 变为主 .88/副 114（§3.1 勘误）；127.0.0.1 直连路径不经过 DNS，本地开发不受影响。

### 验证台账

| 验证项 | 结果 | 证据 |
|---|---|---|
| A：DNS 三断言 | ✅ | @.88 api→192.168.2.88；@.88 baidu→真实 IP；@114 api→CF 边缘（评审复跑一致） |
| B：直连面四断言 | ✅ | /health 200、真短码 303、媒体票据 206、/api/v1 404（评审复验 200/404 一致） |
| B：LE 证书 | ✅ | CN=api.xiaoluedu.top，至 2026-12-05，openssl 实锺（评审复核） |
| C step0：双 DNS 下发 | ✅ | getpacket en7 {192.168.2.88, 114.114.114.114}（评审实锺） |
| C.2 全链（Mac 作 DHCP 客户端） | ✅ | 真实 URL：/s/8CM9Eudnpp → 303 现签 /t/ → 落地页 200（98.7KB）→ /media 206 64KB 分段，全程 remote_ip=192.168.2.88（注：脚本提取需反转义 HTML `&amp;` 实体，浏览器自动处理） |
| §9.2 降级实测 | ✅ | root 停 dnsmasq 30s：系统解析全部回退 CF 边缘 IP 仅 +1s（副 DNS 兜底=走隧道不断网）；拉回即恢复直连 |
| C.3 蜂窝回归（隧道侧） | ✅ | 未改任何 LAN 外设施 + 强制走 CF 边缘 IP 的 /health 200；**用户蜂窝真机照常可用**（2026-09-06 实测） |
| C.2 真机 | ✅ | **用户真机实测（2026-09-06 10:14）**：ggtms 教师手机重连 Wi-Fi → /s/ 7pIDzDQhKL 全链可用、播放正常、拖动明显变快；caddy 日志实锺：来源 192.168.2.68（iPhone UA），303→200（57.7ms）→beacon×2→三路视频 Range 预载 + 多次 seek 跳转（41MB/65MB/3MB）全部 206，小段 62-130ms |
| C.4 办公设备抽查 | ✅ | 用户实测（静态 IP+DNS 自动获取形态的办公电脑）：`nslookup api.xiaoluedu.top` 经 .88 应答。**三个随察**：① 首查"DNS request timed out"=nslookup 对 DNS 服务器做 PTR 反查被转发公网空等——已加 `bogus-priv`（私网 PTR 本地即时 NXDOMAIN，实测 14ms）；② 应答含 CF 的 AAAA（`address=` 只覆盖 A）——本网无 v6 路由，设备实际用 A 直连（Happy Eyeballs 兜底），无害且坐实"开 v6 前须重审"；③ **手动写死 DNS 的设备不吃 DHCP 变更**（继续走隧道，可用但不直连）——存量设备边界，纳入 §4 风险行 |
| 双路径延迟 A/B（Mac 实测，2026-09-06） | ✅ | /health TTFB：直连 13-17ms vs 隧道 0.83-1.24s（~80×）；1MB 媒体段：直连 12-15ms/17-19ms vs 隧道 0.88-1.16s/2.9-5.1s（TTFB ~80×、吞吐 ~180×，隧道 ≈2.7Mbps 与媒体审计口径吻合）——用户"蜂窝明显慢于直连"的体感有数据支撑 |

运维口径：两 daemon 重载/日志/回滚命令见 runbook §5.6（Phase A/B 回滚=各自 `sudo launchctl bootout system/<label>`，DHCP 副 DNS 兜底）。
