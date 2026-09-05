# 同 URL 双路径媒体分发（校内直连 / 校外隧道）设计 spec

- **日期**：2026-09-05
- **状态**：待评审（评审通过后实施；本方案为纯部署面叠加，不改任何仓内代码）
- **背景**：教师视频播放当前全部经 Cloudflare 隧道（免费层无带宽计量，但条款对"大量视频分发"有裁量限制）；规模化后校内直连可同时解决带宽政策与播放体验（seek 延迟）。

---

## §0 现场事实（全部一手核验，2026-09-05）

| 事实 | 值 | 核验方式 |
|---|---|---|
| 域名 NS | Cloudflare（nikon/joan.ns.cloudflare.com） | dig |
| Mac 内网地址 | 192.168.2.88/24，**DHCP 保留已做**（用户确认） | ifconfig + 用户 |
| Mac 网络 | 有线，常驻机构网 | 用户确认 |
| 网关（XVR1800） | 192.168.2.1 | route get default |
| LAN 当前 DNS（DHCP 下发） | 114.114.114.114 | scutil --dns |
| TL-XVR1800 本地 DNS 覆盖 | **无**（用户查证）——本方案走 dnsmasq 分支的直接原因 | 用户 |
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

- launchd `wiki.dnsmasq`：RunAtLoad + KeepAlive，ExecStart `/opt/homebrew/opt/dnsmasq/sbin/dnsmasq --keep-in-foreground --conf-file=<上述>`；plist 600（ops 铁律：bootout 完全退出再 bootstrap）。
- **不改 Mac 自身 resolver**（保持 114.114.114.114，本地开发行为不变；cloudflared 连边缘不依赖该域名解析，不受影响）。

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
        output file /Users/berton/Library/Logs/caddy-lan.log { roll }
        # 直连流量的唯一可观测来源（axum 侧两路径都是 127.0.0.1，无法区分）
    }
}
```

- launchd `wiki.caddy-lan`：KeepAlive；env 只放 `CF_DNS_TOKEN`；plist 600，模板入仓。

### 3.3 Cloudflare API Token
- 权限：**Zone → DNS → Edit，Zone resources 限定 xiaoluedu.top 单 zone**。
- 泄漏最坏影响 = 该域 DNS 可改（域劫持）→ 按既有密钥纪律（plist 存放、可随时在 CF dashboard 撤销、有使用审计）。

### 3.4 路由器改动（唯一网络侧变更）
- XVR1800 → DHCP 设置：DNS 服务器从 `114.114.114.114` 改为 **主 `192.168.2.88` + 副 `114.114.114.114`**。
- 副 DNS 保留原值是本方案的关键降级设计：dnsmasq 挂/Mac 关机时，客户端按 resolver 回退语义自动用副 DNS → 域名回到公网解析 → 走隧道 = **降级为现状，而不是断网**。
- 既有 DHCP 租约在续租/重连后生效（新接入设备立即生效）。

## §4 失败模式

| 故障 | 表现 | 语义 |
|---|---|---|
| dnsmasq 挂（KeepAlive 秒拉） | DNS 查询主超时 → 副应答（慢 ~秒级） | **降级为现状（隧道）**，不断网 |
| Mac 整机 down | 教师服务全灭（src-server/隧道/网关都在它上） | 与现状同构，非新增 |
| Caddy 挂/证书续期失败 | **校内**打开链接失败（DNS 已指向本机，不会自动回落）；校外正常 | KeepAlive + LE 自动续期（提前 30 天）；runbook 口径：校内打不开→关 Wi-Fi 走蜂窝即隧道 |
| 路由器 DHCP 改动被回退 | 全员回隧道 | 无害 |
| iPhone Private Relay | 该教师解析走 Apple 中继 → 直接走隧道 | 自动回落=现状，无害 |
| 租约未续的设备（新旧 DNS 并存窗口） | 部分走隧道部分直连 | 双路径同时有效，无害 |

唯一新增不可用面 = Caddy 行（直连路径自身故障时校内无自动兜底）——这是 DNS 覆盖式方案换零客户端的固有代价。

## §5 安全面

- LAN 暴露面 = 公网面（同一条 path 白名单）：`/api/v1/*`（login/bind/overview/logs）与管理面在 LAN 同样不可达；媒体 HMAC+fp、`/s/`/`/t/` 限流全部继承（同一 src-server 进程）。
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
1. XVR1800 改 DHCP DNS = 主 .88 副 114。
2. 真机校内 Wi-Fi：打开一条真实 `/s/` 短链全链（303→落地→播放→完成 beacon）；`tail caddy-lan.log` 见记录 = 直连实锺；同一码流拖动 seek 正常。
3. 蜂窝网络真机同一链接 → 隧道全链 + cloudflared 无异常（回归）。
4. 办公设备抽查：正常上网 + `nslookup api.xiaoluedu.top` 经 .88。
5. 回滚：路由器 DNS 字段改回 114（租约续期后全网回隧道；直连路径随 DNS 消失自然停用）。

## §7 观测与运维

- 直连流量：caddy-lan.log（含 roll）；隧道流量：cloudflared/现有日志不变。
- runbook（m3-gray-runbook.md）增补"媒体分发双路径"一节：架构一句话、故障口径（校内打不开→切蜂窝）、回滚三步、证书/token 资产位置。
- 上线后观察一周：双路径 206/429 比例、caddy 进程存续、dnsmasq 存续（KeepAlive 计数）。

## §8 成本与增量

全免费（dnsmasq/Caddy 开源、LE 证书、无 CF 套餐变化）。新增长期面：2 个 launchd 服务 + 1 个 CF token + 路由器 DNS 字段。实施约半天（含真机验证）。

## §9 风险与开放项

1. Caddy custom build 供应链：官方下载 API + sha512 校验 + 版本钉住（记录进 runbook）。
2. 主副 DNS 回退语义依赖客户端 resolver 行为（iOS/Android 均支持多 nameserver 超时回退）——Phase C 用"临时 bootout dnsmasq + 真机还能上网"实测一次降级。
3. Caddy 故障时校内无自动兜底（§4 已述）——接受，靠 KeepAlive + 口径。
4. 本方案不解决校外流量的隧道依赖与条款裁量（那部分仍是现状；若将来校外视频流量也需分流，属另一个方案：R2/Stream，不在本 spec 范围）。
