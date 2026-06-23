-- 006_chat_sessions.sql — Layer 3 Phase A: chat 会话持久化
-- chat_conversations: 每用户私有（user_id 归属）；chat_messages: 引用快照

CREATE TABLE chat_conversations (
    id          BIGSERIAL PRIMARY KEY,
    uuid        UUID NOT NULL DEFAULT gen_random_uuid(),
    project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title       TEXT NOT NULL DEFAULT 'New chat',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_chat_conversations_uuid UNIQUE (uuid)
);
CREATE INDEX idx_chat_conv_owner ON chat_conversations(project_id, user_id, updated_at DESC);

CREATE TABLE chat_messages (
    id               BIGSERIAL PRIMARY KEY,
    uuid             UUID NOT NULL DEFAULT gen_random_uuid(),
    conversation_id  BIGINT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
    role             TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
    content          TEXT NOT NULL,
    refs             JSONB,     -- MessageReference[]（命名避开 SQL 保留字 REFERENCES）
    citations        INT[],     -- 从 <!-- cited:1,3 --> 解析出的页码
    retrieval_ctx    JSONB,     -- 快照：本次检索命中的页（调试/重放用）
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_chat_messages_uuid UNIQUE (uuid)
);
CREATE INDEX idx_chat_msg_conv ON chat_messages(conversation_id, created_at);
