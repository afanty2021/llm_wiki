-- 009_search_providers.sql — Layer 3 Phase C / Layer 4: web-search provider(team 维度,与 llm_providers 一致)
CREATE TABLE search_providers (
    id                BIGSERIAL PRIMARY KEY,
    team_id           INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    provider_type     VARCHAR(50) NOT NULL,   -- tavily(预留 serpapi/searxng/ollama)
    api_key_encrypted TEXT NOT NULL,          -- 复用 utils::crypto + llm key 派生(同 llm_providers 路径)
    base_url          TEXT,                   -- None 用 Tavily 默认 https://api.tavily.com/search
    is_enabled        BOOLEAN NOT NULL DEFAULT TRUE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT search_providers_team_type_unique UNIQUE(team_id, provider_type)
);
CREATE INDEX idx_search_providers_enabled ON search_providers(team_id) WHERE is_enabled = TRUE;
