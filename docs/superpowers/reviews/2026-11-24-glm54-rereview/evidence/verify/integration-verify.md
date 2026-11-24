# 集成测试实跑 + 残渣清理账目（核验轮 2026-11-24）

命令：cd src-server && cargo test --test integration　（debug profile，未触碰 target/release）
START 2026-11-24 07:37:02 CST
START_UTC 2026-11-23 23:37:02
test permissions_test::llm_provider_crud_roundtrip ... FAILED
test result: FAILED. 134 passed; 1 failed; 33 ignored; 0 measured; 0 filtered out; finished in 22.78s
CARGO_EXIT=101
END 2026-11-24 07:37:37 CST
失败断言：permissions_test.rs:55  left: 201  right: 409（同 team 重复 provider_type 期望 409，实得 201）
根因证据：llm_providers 现存约束=主键+team_id 外键，(team_id, provider_type) 唯一约束已 drop → 测试断言未同步；该用例在断言处 panic，后续 DELETE 不执行，会留测试 provider 行（本轮窗口内新增 5 行：跑前 11 → 跑后 16；挂在窗口内新建的测试用户下，按窗口删用户时级联带走，终态回到 11）。

## 残渣对账（UTC 窗口 2026-11-23 23:37:02 – 23:38:00 = CST 07:37:02–07:38:00）
--- 窗口内新建行数（created_at >= 测试起点） ---
activity_logs	0
chat_conversations	7
chat_messages	2
embeddings	0
ingest_jobs	7
learning_events	142
learning_plans	32
llm_providers	5
media_assets	26
projects	117
refresh_tokens	243
research_tasks	7
review_items	12
search_providers	1
short_links	37
teacher_profiles	33
teams	257
users	239
wiki_pages	27
--- LT 域前缀族残渣（跑后） ---

## 清理动作（两笔事务，均带计数断言，任一不符整笔回滚）
1) LT 前缀族（限窗口内创建）：projects 52 / users 151（级联 teams 169、team_members 248、teacher_profiles 33、learning_plans 34、learning_items 95、learning_events 167、short_links 37）/ media_assets 26（按窗口删，含 4 行无 t 前缀、挂钩清扫语句漏掉的「课例甲/乙/后缀容错课例/207e 边界 slug」）。
2) M1/M2 域（限窗口内创建，88 用户名逐类确认全为测试形态，窗口内 wecom_ 用户=0）：projects 65 / users 88（级联 teams 88、team_members 103、wiki_pages 9、llm_providers 5、search_providers 1、ingest_jobs 7、research_tasks 7、review_items 12、chat_conversations 7、chat_messages 2）。
   其中 6 个 pending ingest job + 6 个非终态 research task 若不清，下次服务重启会被 recover_pending 重投进 live 队列。
备份：~/kb-dumps/test-residue-verify-20261124/（26 个 CSV，含 README）

## 终态 vs 跑前基线
table	跑前	清理后	说明
activity_logs	0	0	相同
chat_conversations	7	7	相同
chat_messages	2	2	相同
embeddings	79067	79067	相同
ingest_jobs	27	27	相同
ingested_files	1608	1608	相同
learning_events	820	653	减少 167（10-15 遗留 LT 测试夹具）
learning_items	367	272	减少 95（10-15 遗留 LT 测试夹具）
learning_plans	110	76	减少 34（10-15 遗留 LT 测试夹具）
llm_providers	11	11	相同
media_assets	841	841	相同
projects	118	66	减少 52（10-15 遗留 LT 测试夹具）
refresh_tokens	4	4	相同
research_tasks	7	7	相同
review_items	4616	4616	相同
search_providers	2	2	相同
short_links	74	37	减少 37（10-15 遗留 LT 测试夹具）
teacher_profiles	46	13	减少 33（10-15 遗留 LT 测试夹具）
team_members	373	125	减少 248（10-15 遗留 LT 测试夹具）
teams	266	97	减少 169（10-15 遗留 LT 测试夹具）
users	260	109	减少 151（10-15 遗留 LT 测试夹具）
wiki_pages	18435	18422	减少 13（10-15 遗留 LT 测试夹具）
非终态任务：ingest 0 / research 0；窗口内残留 users/projects/media = 0/0/0。
说明：减少的行全部是 10-15 那轮集成测试遗留的 LT 前缀测试夹具（由测试挂钩自带的前缀清扫在开跑时级联删除）；wiki_pages 少的 13 页是旧 LT 测试项目名下的夹具页——长期跟踪的「总页 18435」实含 13 页测试夹具，真实内容页为 18422。
