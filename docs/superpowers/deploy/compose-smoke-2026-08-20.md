# compose prod 启动冒烟复验（2026-08-20 23:00）

- 栈：db(pgvector:pg16) + redis(7-alpine) + server(本地镜像 llm_wiki-server) + nginx(alpine)，端口覆盖 127.0.0.1:18080
- 结果：`/health` 200（~8s）；db/redis healthy、server/nginx Up
- **复验暴露并修复真 bug**：宿主侧插值名为单下划线（`${JWT_SECRET}`/`${MEDIA_SIGNING_KEY}`/`${TRAINING_ADMIN_TOKEN}`），与 bootstrap.env 导出的双下划线名不符 → 渲染空串 → 容器安全校验拒绝启动（crash-loop "JWT_SECRET must be set to a secure value"）。已对齐为双下划线（docker-compose.prod.yml:47/51/55）。T3 当时"通过"系实施者 shell 手动导出单下划线名所致——执行留痕缺失的代价实证。
- 镜像来源：T3 构建产物本地复用（Docker Hub 直连超时；nginx 用镜像源 tag 复用），生产全新环境首次需配 registry mirror 或预导入
- 拆除：down -v（卷清除），override 已删
