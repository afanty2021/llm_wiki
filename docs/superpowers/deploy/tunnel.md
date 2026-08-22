# cloudflared 正式隧道操作记录（2026-08-20）

- 域名 xiaoluedu.top（腾讯云购入，NS 已切 Cloudflare：nikon/joan.ns.cloudflare.com，免费计划）
- 隧道 lt-training（id 63f3063e-d510-4879-9805-634a247cf3cb）；`~/.cloudflared/config.yml` 单 ingress：api.xiaoluedu.top → http://127.0.0.1:8080
- DNS：`cloudflared tunnel route dns lt-training api.xiaoluedu.top`（CNAME 自动）
- 运行：launchd com.cloudflare.cloudflared（KeepAlive；plist 由 T14 模板 .disabled 恢复启用）
- 临时 trycloudflare 隧道已停（旧 vienna-* 链接失效；教师侧"重新发链接"即得正式域名短链）
- PUBLIC_T_BASE 三处已切 https://api.xiaoluedu.top（主 config MCP env / profile config / 经 gateway 重启生效）
- 验证：/health 200；/s/ 短链 → 303 → /t/ 页 200 全链实测
- 回滚：停隧道 `launchctl bootout gui/501/com.cloudflare.cloudflared`；DNS 删除在 CF 面板

## SEC-5 path 级收窄（2026-08-22，M4 前置收口）

- **变更**：ingress 从 hostname 级全量转发收窄为 path 白名单——仅 `^/(t|s|media)/.*$|^/health$`
  穿透到 8080，其余（含全部 `/api/v1/*` 管理面）隧道层 `http_status:404`。
- **依据**：分支终审 SEC-5（hostname 级转发是放大器）；gateway/MCP 走 127.0.0.1 直连不经隧道，
  教师场景公网只需落地页/短链/媒体/探针四前缀。
- **实测**（外网域名）：/health 200；/api/v1/auth/login、/api/v1/users/1、根路径均隧道 404（空体）；
  /t/假token 403 友好页、/s/假码 404 JSON、/media/假slug 403 JSON——白名单内外按 body 可区分。
- **注意**：此版 cloudflared `ingress validate` 对新旧配置均打提示且 exit 1，退出码不可作判据——
  以 bootout+bootstrap 重载后的外网实测为准。
- **回滚**：`cp ~/.cloudflared/config.yml.bak-260822 ~/.cloudflared/config.yml` + 重载 launchd。
