-- 020: 播放遥测——learning_events 增 'play_progress' 事件类型；learning_items 增 'watched' 状态。
-- 配套：t_page.rs POST /t/:token/play（beacon 心跳，独立限流桶）+ projection::apply_play_progress
-- （ended → pending/viewed → watched 单向投影，completed 不回退）+ rebuild 重放链扩展。
-- 部署顺序：先应用本迁移再起新二进制（旧代码只写旧类型，CHECK 放宽对旧代码无影响）。

ALTER TABLE learning_events DROP CONSTRAINT learning_events_event_type_check;
ALTER TABLE learning_events ADD CONSTRAINT learning_events_event_type_check
    CHECK (event_type IN ('view','seen','complete','ask','plan_created','play_progress'));

ALTER TABLE learning_items DROP CONSTRAINT learning_items_status_check;
ALTER TABLE learning_items ADD CONSTRAINT learning_items_status_check
    CHECK (status IN ('pending','viewed','watched','completed'));
