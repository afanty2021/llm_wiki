-- LLM Providers 配置表
-- 每个项目可以配置多个 LLM providers（OpenAI, Anthropic, Google, Ollama 等）
CREATE TABLE llm_providers (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    provider_type VARCHAR(50) NOT NULL,
    api_key_encrypted TEXT NOT NULL,
    base_url TEXT,
    model VARCHAR(100) NOT NULL DEFAULT 'gpt-4o',
    context_size INTEGER NOT NULL DEFAULT 128000,
    is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_llm_providers_project ON llm_providers(project_id);
CREATE INDEX idx_llm_providers_type ON llm_providers(project_id, provider_type);
CREATE INDEX idx_llm_providers_enabled ON llm_providers(project_id) WHERE is_enabled = TRUE;
