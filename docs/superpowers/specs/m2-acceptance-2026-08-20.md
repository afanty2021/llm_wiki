# M2 验收记录 — 2026-08-20

> 分支 feat/Training-System（merge-base b8a43cc4 之后全部 M2 提交，含计划外热修，逐项披露于 §5）。
> 计划：docs/superpowers/plans/2026-08-18-training-m2-learning-domain.md（r2 修订版）· Spec：2026-08-17-teacher-training-design.md v5。

## 1. 交付物对照（spec §9 M2 行逐项）

| 交付物 | 实现 | 验证 |
|---|---|---|
| migration 014 learning 三表 | T5，与 spec §4.1 逐字符一致（partial unique idx_plans_period + CHECK 约束） | 评审 0 findings；psql \d 留档 |
| training API 批 1/2 | T7（profile/events(ask)/progress）+ T8（plans/items/link/complete + projection.rs） | 集成测试矩阵（幂等并发/归属 404/单调守卫）；review clean |
| /t/ 落地页三端点 | T9（view 事件同事务、seen 双粒度 Option\<Json\>、complete、XSS 五字符转义先转义后 linkify） | 敌意 fixture 结构白名单断言；HMAC 三向量 openssl 独立重算一致 |
| /s/ 短链（计划外，T9b） | GET /s/:code → 303 → 现签 7d /t/ token；10 字符 59.5bit | LLM 截断长链的结构性根治，live 验证 |
| MCP teacher-tutor 工具组 | T10：src-server 形态 10 工具 + TeacherCredentialStore（single-flight/原子写/BASE_URL fail-fast） | 27/27 node --test；token 零泄漏面走查 |
| SKILL.md + dry-run | T11：四流程 + 身份硬规则 + 对抗脚本 + 残余风险留档 | mock 逐字段对照真实 DTO |
| Hermes 接线 | T12：profile + platform_toolsets.wecom:[skills] + keep-route 路由 + deploy.sh 四态 | 沙箱验证（幂等×3、字节级回滚） |
| 隧道 | 临时 quick tunnel（正式域名隧道待 USER，记偏差 §5） | 全链 200 实测 |
| launchd 保活 | T14 + 后续补件（src-server/cloudflared 模板、iogpu daemon、omlx 8001） | 自愈实测（kill → 6s 拉起） |
| 白名单 profile | platform_toolsets.wecom 门控，"执行 ls" 零工具可调 | live 实测拒绝（23:04 日志坐实） |
| 日志脱敏 + /ingest 收敛 | T13：/t//media//s/ 前缀脱敏；/ingest/jobs/:id 项目鉴权 | lib 3+1 例；401/200/404 矩阵 |
| 真机件预转 + HEVC 确认 | 5 件 H.264（videotoolbox+faststart）+ playback_path 补登 | 全链 206+h264；upsert 清空 bug 已修（16a） |
| E2E | 见 §2 | live 全链 |

## 2. E2E live 验证（2026-08-19/20，iPhone 8 Plus 企微 + 测试教师账号）

1. **教师全链** ✅：企微消息 → lt-tutor 路由 → 问卷（真实 bind+profile 落库）→ 定制清单 5 项 → 短链转发无损 → 手机打开落地页 → **视频正常播放**（playsinline 修复后）→ Transcript/摘要可读 → 完成按钮 → 投影（item385 completed+时间戳、386/387 viewed、388/389 pending）。
2. **owner 隔离** ✅：用户自有会话 keep-route 走 default（18:56 日志坐实 agent:main）。
3. **白名单** ✅："执行ls" → 10.1s、1 次 API 调用、零工具、礼貌拒绝。
4. **鉴权矩阵抽查** ✅：plan_link token 调 /api → 401；B 访 A 的 plan → 404；B 完成 A 的 item → 404。
5. **对话确认完成路径**（"回企微说看完了"）：未 live 测（按钮路径已证，SKILL 流程④编排有 dry-run 覆盖）——记为已知未验项。

## 3. 夜窗执行（automation-e9999cbd，两阶段）

- 转写 **48/48**（19.9× 实时，带域词 prompt；首跑 18 后续跑 30 新+18 复用）；
- ingest **48/48**（夜 43 + 晨 5 重试全过；48 条 usage 日志证据链）；
- 首批全量 ingest 首次达成（M1 41 → 48）。

## 4. 真机与媒体

- iPhone 8 Plus（iOS WKWebView）：`playsinline` 三连修复后 HEVC 原件与 H.264 均可播（**原判定"设备不支持 HEVC"被推翻**——真因是缺 playsinline 属性）；
- 预转 5 件 H.264（144/152/142/157/123，192-833MB）入 out/h264-cache（gitignore）+ playback_path 登记；
- **M4 决策数据**：iPhone 原生播 HEVC ⇒ 按需转码缓存仅服务安卓用户；
- 修复：media-assets upsert 曾以 None 清空补登路径（16a，COALESCE 保留，红绿测试）。

## 5. 偏差与计划外变更（全部留档于 SDD ledger）

| # | 变更 | 动因 |
|---|---|---|
| 1 | T9b /s/ 短链 | LLM 两次截断 164 字符 token（SKILL 硬规则无效后的结构性根治） |
| 2 | playsinline 热修（fae934f8，控制器直改 14 行，SDD 例外披露） | 夜窗前 25 分钟紧急、教师在场 |
| 3 | Hermes venv→conda Hermes-3.11 切换 + venv 删除 | venv 缺 mcp SDK/lark（崩溃循环+MCP 缺失根因）；USER 指正 |
| 4 | MCP 声明移入主 config | profile 作用域 contextvar 不被启动 discovery 读取（源码+实测）；代价：default 会话也见 10 工具（残余风险 §6） |
| 5 | provider key 重录 | DB 密文为历史 secret 加密，launchd 服 bootstrap secret 不匹配（omlx 无鉴权，占位即可） |
| 6 | iogpu 42GB 开机 daemon + Qwen pinned + KV 4bit | omlx 内存压力下提前 EOS（夜 5 失败根因，源码联调定位）；三防线之服务端两层 |
| 7 | step1 解析失败自动重试（43816ffa） | 瞬态模型输出兜底（三防线之客户端层） |
| 8 | omlx 8001 launchd 化 | 手工进程脆弱性当日即踩 |
| 9 | 临时隧道先行 | USER 决定（正式域名待接入）；trycloudflare 本机 DNS 解析受限已记 |
| 10 | 重启自愈改造（Docker 登录项/launchd 接管/cloudflared disabled） | 系统重启暴露"只写不载"裁决不成立 |

## 6. 已知残余风险

- **身份伪造结构性缺口**（M3）：LLM 产出 wecom_userid 无硬绑定；SKILL 规则+dry-run 为缓解；主 config MCP 方案使 default 会话也可见 training 工具，风险面上调；
- 计划外遗留：`withinWindow` 结束时刻排他 off-by-one（发现记档，未改码——跑批用默认夜窗语义即可规避）；
- 8000 视觉服 launchd exit 78（**今日之前旧疾**，培训系统不依赖）；
- 临时隧道 URL 随重启轮换 + trycloudflare 无 SLA——正式域名接入前不面向真实教师放量；
- 控制器热修与人工介入清单见 SDD ledger（终审 review 将复核）。

## 7. 测试汇总

cargo lib 242/242 + integration 98/98（含 /s/ 矩阵；环境性 flake 均经 stash 复现甄别）· vitest 123/123 · mcp node --test 27/27 · dry-run 4 脚本（含对抗）。

## 8. M3+ 待办指针

问卷编排/overview/周报 cron/灰度/重启演练（M3）；按需转码缓存（M4，安卓 only）；身份会话级绑定（M3 优先级上调）；Hermes 侧 lazy-install 阻塞事件循环 + uv 镜像配置（上游问题，留档）。
