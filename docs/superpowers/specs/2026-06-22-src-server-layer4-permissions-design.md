← [设计文档索引](../)

# src-server Layer 4 设计：多用户/权限（team role enforce + provider team 维度）

> **Date**: 2026-06-22 · **Status**: Draft (待 review) · **Type**: 子系统详细设计
> **Scope**: src-server 权限层——把 `team_members.role`（owner/admin/member）enforce 到 project/team 操作；`llm_providers` + `search_providers` 升 **team 维度** + provider CRUD；保持 team 级共享（不加 `project_members`）。
> **Related**: [Layer 3 总览](2026-06-21-src-server-layer3-chat-review-research-design.md) · [Phase B spec](2026-06-21-src-server-layer3-phase-b-review-design.md)（resolve handler enforce）· [Phase C spec](2026-06-22-src-server-layer3-phase-c-research-design.md)（search_providers 维度联动）

---

## 1. 背景与依赖

Layer 1–3 已建好 team/project/user schema 与所有 project-scoped 路由的 team-membership 鉴权。Layer 4 在其上**补 role 分级 + provider 自助配置**。

**关键事实**（探索核实 verbatim）：

- **schema 已就绪，本层不动 team/project/user 表**：
  - `team_members(team_id, user_id, role VARCHAR(20) NOT NULL CHECK (role IN ('owner','admin','member')), joined_at)`，复合主键 `(team_id, user_id)` —— role 枚举约束已有（`migrations/001_initial_schema.sql:30-36`）。
  - `projects(team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE, created_by, …)`，`UNIQUE(team_id, name)`（`001:41-49`）。`create_project` 强制 `team_id`（`routes/projects.rs:85-142` 的 `check_team_membership`）。
  - `users` 无全局 role、无 `team_id`（`001:5-16`）。
  - 注册自动建 personal team（`<username>'s team`）+ self 为 owner（事务内，`routes/auth.rs:69-169`）—— **不动**。
- **现状鉴权**：
  - `middleware/project_guard.rs::check_project_access(state, headers, project_id) -> Result<(user_id, team_id), AppError>`：JOIN `projects↔team_members`，查了 `tm.role as member_role` **但未使用**，非成员→403。**所有 project-scoped 路由都调它**（pages/graph/search/reviews/chat/chat_sessions/ingest/files），无遗漏。
  - `routes/teams.rs` 有 `check_membership` + `require_owner` / `require_owner_or_admin`，**仅 team 管理操作**用（update/delete team、add/remove member）。project 资源操作完全不区分 role。
- **llm_providers 现状**（`migrations/002_add_llm_providers.sql`）：`project_id INTEGER NOT NULL`（**project 维度**），有 `provider_type/api_key_encrypted/base_url/model/context_size/is_enabled`。**无 CRUD 路由**（后台直配，仅 `services/llm.rs::get_llm_config` 读）。解密走 `services/llm.rs::decrypt_api_key`（JWT secret 派生 key + `utils::crypto::decrypt_api_key`），加密对称 `utils::crypto::encrypt_api_key(text, &[u8;32])`（`utils/crypto.rs:22`）。
- **search_providers**（Phase C `009`，**未实施**）：设计为 project 维度 —— 本层一并升 team。
- **无跨 team 共享 / `project_members` / invite 外部用户**（grep 确认）—— 本层保持 team 级共享（YAGNI）。

**3 个 enforce gap**（本层解决）：
1. project 资源操作不区分 role（member 能删页/配 provider/删 project）。
2. llm_providers 无 CRUD 路由 + project 维度（不能自助配、每 project 重配）。
3. 无 project 级共享 —— **本层不做**（保持 team 级）。

## 2. 范围

**包含**：
1. `RequiredRole` enum + `role_meets` 纯函数 + `check_project_access_with_role` / `check_team_access_with_role`（集中 role 检查，替代"查 role 不用"）。
2. migration `010_llm_providers_team_scope.sql`：`llm_providers.project_id → team_id`（迁移现有数据）+ `UNIQUE(team_id, provider_type)`。
3. Phase C `009_search_providers.sql` 改 team 维度（未实施，直接改）。
4. provider 查询改 JOIN：`get_llm_config` + `web_search::provider_for_project`（入参仍 project_id，内部 JOIN `projects.team_id`，worker 无痛）。
5. team-scoped provider CRUD 路由（`/teams/:id/llm-providers` + `/teams/:id/search-providers`，Admin，GET 不回传 key）。
6. project 侧 enforce：DELETE 页/文件 → Admin；DELETE project → Owner。
7. team 侧 enforce：add/remove member 收紧 Owner；`teams.rs` helper 统一到 `check_team_access_with_role`。

**不包含（YAGNI / 延后）**：
- `project_members` / 跨 team 共享 / 邀请外部用户到单个 project。
- owner 转让流程 / 最后一个 owner 保护（保持现状：不能移 owner）。
- 全局 user role（admin/user 跨 team）。
- member 创建 project 限制（保持现状：member 可建）。
- provider 按 `provider_type` 选择性取用（`get_llm_config` 仍 `ORDER BY id LIMIT 1` 取第一个 enabled）。
- 前端权限 UI（后端 enforce 优先，前端按需后补）。

## 3. 关键设计决策

| 决策 | 取值 | 依据 |
|------|------|------|
| 共享模型 | 保持 team 级（不加 `project_members`） | YAGNI；personal team 模型下多数单 owner，team 级够用 |
| 能力矩阵 | member=协作者：read + write_content 所有 role；manage（删页/配 provider）admin+；administer（删 project/改成员）owner | 多人协作建 wiki，member 可贡献内容但不能破坏配置 |
| provider 作用域 | **team 维度**（llm + search 一致） | worker 无 user 上下文→必须 project/team 固定 provider；team 维度下 personal team≈"我的 key 跨 project"；省去每 project 重配 |
| enforce 架构 | 统一 `check_*_access_with_role(_, _, id, RequiredRole)` + enum | 声明式、DRY、与现有 `check_project_access` 函数模式一致；`role_meets` 共用消除 team 侧两套判断 |
| 现有 `check_project_access` | 保留，委托 `with_role(Member)` | 所有既有调用点零改动，渐进迁移 |
| provider 查询入参 | 仍 `project_id`，内部 JOIN team | 向后兼容所有调用方 + worker（`provider_for_project(pid)`）签名不变 |
| migration 数据 | `project_id→team_id` JOIN 迁移 + orphan DELETE | create_project 强制 team_id，正常数据均非 NULL |

## 4. 数据模型

### migration `010_llm_providers_team_scope.sql`

```sql
-- 010_llm_providers_team_scope.sql — Layer 4: llm_providers 升 team 维度
ALTER TABLE llm_providers ADD COLUMN team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE;
UPDATE llm_providers lp SET team_id = (SELECT team_id FROM projects WHERE id = lp.project_id);
-- create_project 强制 team_id,正常数据均非 NULL;orphan(NULL team_id)属异常,清理
DELETE FROM llm_providers WHERE team_id IS NULL;
ALTER TABLE llm_providers ALTER COLUMN team_id SET NOT NULL;
ALTER TABLE llm_providers DROP COLUMN project_id;
DROP INDEX IF EXISTS idx_llm_providers_project;
DROP INDEX IF EXISTS idx_llm_providers_type;
DROP INDEX IF EXISTS idx_llm_providers_enabled;
-- 迁移前是 project 维度,同 team 多 project 可能各配了同 provider_type 行;
-- 现状无 DELETE 路由,"移除"靠 is_enabled=FALSE,disabled 行会累积。
-- 升 team + UNIQUE 前先去重:每 (team_id, provider_type) 优先保留 enabled 行
-- (is_enabled DESC → TRUE 先于 FALSE),同状态再取 id 最小——
-- 否则 MIN(id) 可能留下 disabled 行、删掉 enabled 行,使 team 解析到无可用 provider
-- (get_llm_config 过滤 is_enabled=TRUE),chat/ingest/research 全挂,且 DELETE 不可逆。
DELETE FROM llm_providers lp
WHERE lp.id NOT IN (
    SELECT DISTINCT ON (team_id, provider_type) id
    FROM llm_providers
    ORDER BY team_id, provider_type, is_enabled DESC, id
);
ALTER TABLE llm_providers ADD CONSTRAINT llm_providers_team_type_unique UNIQUE(team_id, provider_type);
CREATE INDEX idx_llm_providers_team_enabled ON llm_providers(team_id) WHERE is_enabled = TRUE;
```

### Phase C `009_search_providers.sql` 改 team 维度（未实施，直接改）

```sql
-- 009_search_providers.sql — Layer 3 Phase C / Layer 4: web-search provider(team 维度)
CREATE TABLE search_providers (
    id                BIGSERIAL PRIMARY KEY,
    team_id           INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    provider_type     VARCHAR(50) NOT NULL,   -- tavily(预留)
    api_key_encrypted TEXT NOT NULL,          -- utils::crypto + llm key 派生
    base_url          TEXT,
    is_enabled        BOOLEAN NOT NULL DEFAULT TRUE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT search_providers_team_type_unique UNIQUE(team_id, provider_type)
);
CREATE INDEX idx_search_providers_enabled ON search_providers(team_id) WHERE is_enabled = TRUE;
```

> `team_members` / `teams` / `projects` / `users` **零改动**。

## 5. enforce 模型（`middleware/project_guard.rs`）

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequiredRole { Member, Admin, Owner }

/// 纯：判断 role 是否满足 required 级别。project 版与 team 版共用。
pub fn role_meets(role: &str, required: RequiredRole) -> bool {
    match required {
        RequiredRole::Member => true,
        RequiredRole::Admin => role == "admin" || role == "owner",
        RequiredRole::Owner => role == "owner",
    }
}

/// project-scoped 鉴权 + role 级别。返回 (user_id, team_id, role)。不够→403。
pub async fn check_project_access_with_role(
    state: &AppState,
    headers: &HeaderMap,
    project_id: i32,
    required: RequiredRole,
) -> Result<(i32, i32, String), AppError> {
    let claims = require_auth(state, headers).await?;
    let user_id = claims.sub.parse::<i32>()?;
    let row = sqlx::query(
        "SELECT p.team_id, tm.role FROM projects p \
         JOIN team_members tm ON p.team_id = tm.team_id \
         WHERE p.id = $1 AND tm.user_id = $2")
        .bind(project_id).bind(user_id).fetch_optional(&state.db).await?;
    let row = row.ok_or(AppError::PermissionDenied)?;
    let team_id: i32 = sqlx::Row::get(&row, "team_id");
    let role: String = sqlx::Row::get(&row, "role");
    if !role_meets(&role, required) { return Err(AppError::PermissionDenied); }
    Ok((user_id, team_id, role))
}

/// 现有函数保留,委托 Member——所有既有调用点零改动。
pub async fn check_project_access(
    state: &AppState, headers: &HeaderMap, project_id: i32,
) -> Result<(i32, i32), AppError> {
    let (uid, tid, _) = check_project_access_with_role(state, headers, project_id, RequiredRole::Member).await?;
    Ok((uid, tid))
}

/// team-scoped 鉴权 + role 级别(provider CRUD / 成员管理用)。返回 (user_id, role)。不够→403。
pub async fn check_team_access_with_role(
    state: &AppState, headers: &HeaderMap, team_id: i32, required: RequiredRole,
) -> Result<(i32, String), AppError> {
    let claims = require_auth(state, headers).await?;
    let user_id = claims.sub.parse::<i32>()?;
    let role: Option<String> = sqlx::query_scalar(
        "SELECT role FROM team_members WHERE team_id=$1 AND user_id=$2")
        .bind(team_id).bind(user_id).fetch_optional(&state.db).await?;
    let role = role.ok_or(AppError::PermissionDenied)?;
    if !role_meets(&role, required) { return Err(AppError::PermissionDenied); }
    Ok((user_id, role))
}
```

## 6. provider 查询改 JOIN（入参仍 project_id）

`services/llm.rs::get_llm_config` 与 `services/web_search.rs::provider_for_project`（Phase C）SQL 统一改：

```sql
SELECT lp.provider_type, lp.api_key_encrypted, lp.base_url, lp.model, lp.context_size
FROM llm_providers lp
JOIN projects p ON lp.team_id = p.team_id
WHERE p.id = $1 AND lp.is_enabled = TRUE
ORDER BY lp.id LIMIT 1
```

- 函数签名**不变**（`get_llm_config(pool, project_id)`、`provider_for_project(state, project_id)`）—— 所有调用方（chat/ingest/research worker、routes）零改动。
- `search_providers` 的 `provider_for_project` 同款 JOIN。

## 7. 端点契约

**team-scoped provider CRUD**（`routes/llm_providers.rs` 新建 + `routes/search_providers.rs` Phase C 改）：

```
POST   /api/v1/teams/:id/llm-providers          {provider_type, api_key, base_url?, model?, context_size?} → 201（Admin）
GET    /api/v1/teams/:id/llm-providers           当前 enabled provider（api_key 不回传，回 has_key）→ 200（Member 可读）
PUT    /api/v1/teams/:id/llm-providers/:sid      {api_key?, base_url?, model?, context_size?, is_enabled?} → 200（Admin）
DELETE /api/v1/teams/:id/llm-providers/:sid      → 200（Admin）
```
`search-providers` 同构（`provider_type, api_key, base_url?`，无 model/context_size）。

- 鉴权：写操作（POST/PUT/DELETE）`check_team_access_with_role(tid, Admin)`；GET 读 `check_team_access_with_role(tid, Member)`（team 成员可查看 provider 配置，但 key 不回传）。
- 加密：POST/PUT 用 `utils::crypto::encrypt_api_key(plain, &derive_key(&state.config))`（key 派生复用 `llm.rs::decrypt_api_key` 同款 4 行）。
- `UNIQUE(team_id, provider_type)` 冲突 → 409。

## 8. enforce 落地清单

**project-scoped**（`check_project_access_with_role`）：

| 类别 | 端点 | 所需 role | 改动 |
|------|------|----------|------|
| read | GET pages/graph/search/reviews/chat/research/files | Member | 不变（现状=Member） |
| write_content | POST ingest/chat/research；resolve/dismiss review；PUT 编辑页；POST 上传文件 | Member | 不变 |
| manage | DELETE 页；DELETE 文件 | Admin | **改 `with_role(Admin)`** |
| administer | DELETE project | Owner | **改 `with_role(Owner)`** |

> provider CRUD 是 team-scoped（见 §7），不在此表。

**team-scoped**（`check_team_access_with_role`）：

| 端点 | 现状 | 第 4 层 |
|------|------|---------|
| GET team/members、create team、create project、update team | member / 任何认证 / member / admin+ | 不变 |
| **add/remove member** | admin+（`require_owner_or_admin`） | **收紧 Owner**（矩阵唯一收紧点） |
| delete team | owner | 不变 |
| llm/search provider CRUD | 新 / Phase C | Admin（写）/ Member（读） |

**边界明确**：删文件=Admin（破坏性，非 write_content）；编辑页 PUT=Member；create project=Member（保持）；`update_team`=admin+（不属"改成员"，不收紧）。

## 9. teams.rs 收紧 + helper 统一

- `add_member` / `remove_member`：`require_owner_or_admin(&role)?` → `require_owner(&role)?`（收紧 owner only）。
- `check_membership` + `require_owner` + `require_owner_or_admin` **废弃**，改调 `check_team_access_with_role(tid, RequiredRole)`：
  - `get_team` / `get_team_members`：Member
  - `update_team`：Admin
  - `delete_team`：Owner
  - `add_member` / `remove_member`：Owner（收紧后）
- `create_team` / `create_project` 不变（任何认证 / `check_team_membership(Member)`）。

## 10. 错误处理

| 场景 | 处理 | HTTP |
|------|------|------|
| role 不够（member 删页等） | `PermissionDenied` | 403 |
| 非 team 成员 | `PermissionDenied`（现状） | 403 |
| 删/改不存在 provider | `ResourceNotFound` | 404 |
| 同 team 重复 `provider_type`（UNIQUE 冲突） | `Conflict` | 409 |
| provider api_key 解密失败 | `EncryptionError`（现状） | 500 |
| migration orphan（NULL team_id） | 迁移期 `DELETE` | — |

## 11. 测试策略

**纯函数**（`middleware/project_guard.rs #[cfg(test)]`）：
- `role_meets`：`(member,Member)✓ (member,Admin)✗ (admin,Admin)✓ (owner,Admin)✓ (admin,Owner)✗ (owner,Owner)✓`

**集成测试**（`tests/integration/permissions_test.rs`，新增 helper `setup_team_with_roles(server, tag) -> (team_id, {owner,admin,member} tokens)`：建 team + INSERT 三 user 为三 role）：
1. **role_matrix_project**：member DELETE page→403 / admin→200；member DELETE project→403 / admin→403 / owner→200
2. **role_matrix_provider**：member POST llm-providers→403 / admin→201
3. **team_scope_shared**：team 配一次 llm_provider → 该 team 下两 project 直调 `get_llm_config` 都取到（跨 project 共用，worker 同款路径）
4. **provider_crud_roundtrip**：加密往返 + GET 不回传 key + 同 team 配第二个同类型→409
5. **member_mgmt_owner_only**：admin add_member→403 / owner add_member→200（验证收紧）
6. **migration_010**：迁移后 `team_id NOT NULL` + 旧 `project_id` 数据正确映射 + **enabled 优先保留**（seed 同 `(team,provider_type)` 两行：老 disabled + 新 enabled → 迁移后保留 enabled 行，断言该 team `get_llm_config` 仍能取到）

> 不测：provider 解密失败 500（异常路径 YAGNI）；migration 走 CI（手动 psql 验证，项目惯例）。

## 12. 实现拆分（为 writing-plans 预热）

1. migration `010`（llm_providers team 维度）+ 改 Phase C `009` 为 team 维度 + psql 验证
2. enforce 模型：`RequiredRole` + `role_meets`（TDD 纯函数）+ `check_project_access_with_role` + `check_team_access_with_role` + `check_project_access` 委托
3. provider 查询改 JOIN：`get_llm_config` + `web_search::provider_for_project`（Phase C）SQL 改 + 既有 lib 测试不回归
4. `routes/llm_providers.rs`：team-scoped CRUD（Admin 写 / Member 读，加密往返，GET 不回传 key，409）
5. `routes/search_providers.rs`：Phase C 改 team-scoped + Admin（并入第 4 层方案）
6. project 侧 enforce：DELETE 页/文件 → `with_role(Admin)`；DELETE project → `with_role(Owner)`
7. team 侧 enforce：`teams.rs` add/remove member 收紧 Owner + 全文件改 `check_team_access_with_role`（废弃 `require_*` helper）
8. 集成测试 `permissions_test.rs` + clippy 全绿

## 13. 待定 / 延后 + Phase C 联动

- `project_members` / 跨 team 共享 / invite 外部用户 —— 后续 layer（若需）
- owner 转让 / 最后 owner 保护 —— 保持现状（不能移 owner）
- 全局 user role —— 不做
- provider 按 type 选择性取用 —— 仍 `LIMIT 1`
- 前端权限 UI —— 后端先，前端按需

**Phase C 联动**：search_providers 的 team 维度 + `provider_for_project` JOIN 由本层定方案；Phase C 已批 plan 的 Task 8（search_providers CRUD）需相应小改（project-scoped → team-scoped + Admin，schema `009` 用 §4 的 team 维度版本）。实施顺序由用户定（可第 4 层先实施 provider 维度与 CRUD，Phase C 实施时直接复用）。

---

## 附录：与 Layer 3 的关系

- **不动 Phase A/B/C 的业务逻辑**：仅 (a) Phase C 的 search_providers 维度 + 路由 scope 调整；(b) 各写/删 handler 加 role enforce（行为：原 member 可做的破坏性操作改 403，其余不变）；(c) `get_llm_config`/`provider_for_project` SQL 改 JOIN（签名不变）。
- **向后兼容**：`check_project_access` 保留委托；所有现有 read/write_content 调用点语义不变（仍 Member 放行）。
