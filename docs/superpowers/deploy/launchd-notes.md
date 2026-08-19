# launchd 保活：src-server + cloudflared（Task 14 记录）

> 状态（2026-08-19）：两个 plist 已落位 `~/Library/LaunchAgents/`（600，含 secret）但 **未加载**。
> 控制器裁定：当晚 23:30 自动化会直接 kill+rebuild+restart src-server，若 KeepAlive 当日接管，
> kill 会与 launchd 复活竞争（旧二进制中途复活 → 端口冲突）。真实加载推迟到 **Task 16**。
> cloudflared 额外依赖 Task 15 创建 tunnel `lt-training`，当前 plist 为占位。

## 布局

| 位置 | 内容 | 权限 |
|------|------|------|
| `~/Library/LaunchAgents/wiki.src-server.plist` | 实值（secret 内联自 `tools/transcriber/out/bootstrap.env`） | 600 |
| `~/Library/LaunchAgents/com.cloudflare.cloudflared.plist` | 实值（无 secret；凭据走 `~/.cloudflared/`） | 600 |
| `docs/superpowers/deploy/wiki.src-server.plist.template` | 占位模板（`__JWT_SECRET__` 等） | 入库 |
| `docs/superpowers/deploy/com.cloudflare.cloudflared.plist.template` | 同上（无占位符） | 入库 |

从模板重生成实值 plist（secret 不经手 shell 历史——bootstrap.env 直读直替换）：

```bash
cd /Users/berton/Github/kb-obsidian/llm_wiki
ENVF=tools/transcriber/out/bootstrap.env
sed -e "s|__JWT_SECRET__|$(grep '^JWT__SECRET=' $ENVF | cut -d= -f2-)|" \
    -e "s|__MEDIA_SIGNING_KEY__|$(grep '^MEDIA__SIGNING_KEY=' $ENVF | cut -d= -f2-)|" \
    -e "s|__TRAINING_ADMIN_TOKEN__|$(grep '^TRAINING__ADMIN_TOKEN=' $ENVF | cut -d= -f2-)|" \
    -e "s|__TRAINING_PROJECT_ID__|$(grep '^PROJECT_ID=' $ENVF | cut -d= -f2-)|" \
    docs/superpowers/deploy/wiki.src-server.plist.template \
    > ~/Library/LaunchAgents/wiki.src-server.plist
chmod 600 ~/Library/LaunchAgents/wiki.src-server.plist
cp docs/superpowers/deploy/com.cloudflare.cloudflared.plist.template \
   ~/Library/LaunchAgents/com.cloudflare.cloudflared.plist
chmod 600 ~/Library/LaunchAgents/com.cloudflare.cloudflared.plist
plutil -lint ~/Library/LaunchAgents/wiki.src-server.plist ~/Library/LaunchAgents/com.cloudflare.cloudflared.plist
```

## 环境变量映射（bootstrap.env → plist EnvironmentVariables）

| bootstrap.env 键 | plist 键 | 处置 |
|---|---|---|
| `JWT__SECRET` | `JWT__SECRET` | 内联（启动校验必填；dotenvy 不覆盖已有 env，优先于 .env 的黑名单占位符） |
| `MEDIA__SIGNING_KEY` | `MEDIA__SIGNING_KEY` | 内联（/media 签名） |
| `TRAINING__ADMIN_TOKEN` | `TRAINING__ADMIN_TOKEN` | 内联（/bind 鉴权） |
| `PROJECT_ID` | `TRAINING__PROJECT_ID` | 内联改键（Task 3 惯例：`Option<i32>`） |
| ——（任务指定） | `AUTH__REGISTRATION_ENABLED=false` | 内联（default.json 的 `true` 是 dev 遗留，env 覆盖关闭注册） |
| ——（显式化） | `SERVER__HOST=127.0.0.1` / `SERVER__PORT=8080` | 内联（与 default.json 一致但显式声明，端口可用 env 整体覆盖——见 boot test） |
| ——（PATH） | `PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin` | launchd 无登录 shell PATH；server 对 pdf 解析 shell 出 `pdftotext`（poppler，/opt/homebrew/bin） |
| `ADMIN_PASSWORD` / `SVC_PASSWORD` / `TEAM_ID` | （无） | **不内联**：grep 证实 src-server 从不读取（bootstrap.sh 建号一次性输入 / 企业微信侧使用） |

DB/Redis/存储等其余运行期配置由 `config/default.json` + cwd 的 `.env`（dotenvy）提供，与 live 8080 实例同源。launchd stdout/stderr 兜底日志在 `/Users/berton/Library/Logs/wiki-launchd/`；服务自身轮转日志仍在 `src-server/logs/`（config `logging.dir`）。

## KeepAlive / ThrottleInterval 演练（一次性哑服务，已清理）

哑服务：`/tmp/wiki.keepalive-drill.sh`（bash sleep 循环）+ `/tmp/wiki.keepalive-drill.plist`（KeepAlive=true, ThrottleInterval=30，与真实 plist 同参数）。2026-08-19 13:05 实测：

| 阶段 | 事件 | 时刻 | 结果 |
|---|---|---|---|
| load | `launchctl bootstrap` → 进程 pid 52114 | 13:05:32 | RunAtLoad 即起 |
| A | 存活 35s（> 30s 节流窗）后 `kill -9` | 13:06:07 | **0s 复活**（pid 52188，同秒）——节流窗已服务满，KeepAlive 立即拉起 |
| B | 复活后立刻（0s）再 `kill -9` | 13:06:07 | **30s 后复活**（pid 52450 @ 13:06:37）——节流窗内死亡，ThrottleInterval 精确强制 30s |
| unload | `launchctl bootout` | 13:06:38 | 进程消失、`launchctl print` 报 Bad request（已卸载）、/tmp 文件全清 |

结论：kill 后自愈 ≤30s（存活超窗时即时）；crash-loop 最快 30s 一次，无复活风暴。

## 真实 plist 形状 18081 端口 boot test（已拆除）

以 **已安装实值 plist** 为底，仅改 `Label→wiki.src-server.boottest`、`SERVER__PORT→18081`、日志→/tmp，`launchctl bootstrap` 后实测（2026-08-19 13:07）：

- `curl http://127.0.0.1:18081/health` → **HTTP 200** `{"status":"ok",...}`，1s 内就绪
- 监听进程 = `src-server/target/release/llm-wiki-server`（先 `cargo build --release` 完成，53.7s）
- 进程 env 核验（值脱敏）：`JWT__SECRET` / `MEDIA__SIGNING_KEY` / `TRAINING__ADMIN_TOKEN` / `TRAINING__PROJECT_ID=614` / `AUTH__REGISTRATION_ENABLED=false` / `SERVER__HOST` / `SERVER__PORT=18081` 全部在位
- live 8080 全程未动（pid 42083 前后一致，/health 持续 200）
- `launchctl bootout` 拆除：18081 无监听、无 release 二进制残留、临时 plist/日志删除

## Task 16 加载指令（当晚自动化窗口之后执行）

前置：确认 23:30 自动化已完成、8080 上无手工进程（`lsof -nP -iTCP:8080 -sTCP:LISTEN`）；cloudflared 需 T15 已建好 tunnel `lt-training`。

```bash
# 1.（若代码有更新）重建 release 二进制——launchd 不该触发编译
cd /Users/berton/Github/kb-obsidian/llm_wiki/src-server && cargo build --release

# 2. 停掉手工/自动化启动的 src-server（否则 8080 端口冲突）
#    （确认 pid 属于 src-server 后）kill <pid>

# 3. 加载（现代语法；GUI 会话 uid=501）
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/wiki.src-server.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cloudflare.cloudflared.plist

# 4. 验证
launchctl print gui/$(id -u)/wiki.src-server | grep -E "state|pid"
curl -s http://127.0.0.1:8080/health
launchctl print gui/$(id -u)/com.cloudflare.cloudflared | grep -E "state|pid"

# 5. 自愈抽查（等 35s 后 kill -9 server pid，应在 ~0-30s 内复活、/health 恢复 200）

# 卸载/回滚
launchctl bootout gui/$(id -u)/wiki.src-server
launchctl bootout gui/$(id -u)/com.cloudflare.cloudflared
```

旧式等价：`launchctl load -w <plist>` / `launchctl unload -w <plist>`。

## 已知后续（T16 注意）

- **CORS**：default.json 只放行 `localhost:1420/5173`；tunnel 域名对外访问需把 `https://<tunnel-host>` 加进 `CORS__ALLOWED_ORIGINS`（plist env 加一行即可，注意逗号串列表语义）。
- **二进制更新**：launchd 跑的是 release 产物快照，rebuild 后需 `launchctl kickstart -k gui/$(id -u)/wiki.src-server`（或 bootout+bootstrap）才吃到新二进制。
- `.env` 的 `JWT__SECRET` 是黑名单占位符：仅当 plist env 缺失时才会被 dotenvy 采用并触发启动拒绝——内联 env 在位即安全。
