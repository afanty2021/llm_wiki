# cloudflared 正式隧道操作记录（2026-08-20）

- 域名 xiaoluedu.top（腾讯云购入，NS 已切 Cloudflare：nikon/joan.ns.cloudflare.com，免费计划）
- 隧道 lt-training（id 63f3063e-d510-4879-9805-634a247cf3cb）；`~/.cloudflared/config.yml` 单 ingress：api.xiaoluedu.top → http://127.0.0.1:8080
- DNS：`cloudflared tunnel route dns lt-training api.xiaoluedu.top`（CNAME 自动）
- 运行：launchd com.cloudflare.cloudflared（KeepAlive；plist 由 T14 模板 .disabled 恢复启用）
- 临时 trycloudflare 隧道已停（旧 vienna-* 链接失效；教师侧"重新发链接"即得正式域名短链）
- PUBLIC_T_BASE 三处已切 https://api.xiaoluedu.top（主 config MCP env / profile config / 经 gateway 重启生效）
- 验证：/health 200；/s/ 短链 → 303 → /t/ 页 200 全链实测
- 回滚：停隧道 `launchctl bootout gui/501/com.cloudflare.cloudflared`；DNS 删除在 CF 面板
