-- 013_training_core.sql — M1：媒体注册表 + 教师档案（spec §4.1）
CREATE TABLE media_assets (
  id SERIAL PRIMARY KEY,
  slug VARCHAR(255) UNIQUE NOT NULL,
  media_ref TEXT NOT NULL,               -- 本机绝对路径，只在本表出现
  playback_path TEXT,                    -- 桶B转码副本（hevc/VOB 等）
  duration_s INTEGER NOT NULL DEFAULT 0,
  codec TEXT,
  kind VARCHAR(10) NOT NULL CHECK (kind IN ('video','audio')),
  chapters JSONB NOT NULL DEFAULT '[]',
  transcript_page_path TEXT,
  source_path TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE teacher_profiles (
  id SERIAL PRIMARY KEY,
  user_id INTEGER UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wecom_userid VARCHAR(100) UNIQUE NOT NULL,
  display_name VARCHAR(100),
  subject VARCHAR(100),
  grade_levels JSONB NOT NULL DEFAULT '[]',
  goals JSONB NOT NULL DEFAULT '[]',
  interests JSONB NOT NULL DEFAULT '[]',
  onboarding_state VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (onboarding_state IN ('pending','surveyed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_media_assets_slug ON media_assets(slug);
CREATE INDEX idx_teacher_profiles_wecom ON teacher_profiles(wecom_userid);
