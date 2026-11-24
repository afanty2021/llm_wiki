| 文档 | 行数 | 最后改动 | 路径引用 | 仍存在 | 点分标识符 | 可解析 | 裸标识符 | 全树可见 |
|---|---|---|---|---|---|---|---|---|
| gateway/CLAUDE.md | 481 | 2026-04-14 | 23 | 9 | 0 | 0 | 10 | 8 |
| agent/CLAUDE.md | 292 | 2026-04-08 | 29 | 27 | 4 | 0 | 31 | 31 |
| hermes_cli/CLAUDE.md | 484 | 2026-04-14 | 23 | 17 | 4 | 0 | 12 | 12 |
| plugins/CLAUDE.md | 330 | 2026-04-08 | 16 | 2 | 1 | 0 | 5 | 3 |
| acp_adapter/CLAUDE.md | 271 | 2026-04-08 | 15 | 5 | 0 | 0 | 4 | 0 |
| cron/CLAUDE.md | 261 | 2026-04-08 | 12 | 5 | 0 | 0 | 5 | 2 |
| environments/CLAUDE.md | 259 | 2026-04-08 | 19 | 0 | 0 | 0 | 7 | 1 |
| tools/CLAUDE.md | 320 | 2026-05-06 | 23 | 19 | 2 | 0 | 10 | 9 |
| tests/CLAUDE.md | 388 | 2026-04-08 | 3 | 3 | 1 | 0 | 11 | 8 |
| docs/adr/001-sync-agent-loop.md | 95 | 2026-04-08 | 1 | 0 | 0 | 0 | 0 | 0 |
| docs/adr/002-tool-registry.md | 109 | 2026-04-08 | 0 | 0 | 0 | 0 | 1 | 1 |
| docs/adr/003-multi-instance.md | 115 | 2026-04-08 | 0 | 0 | 0 | 0 | 2 | 2 |
| docs/adr/004-prompt-cache.md | 103 | 2026-04-08 | 0 | 0 | 0 | 0 | 0 | 0 |
| docs/adr/005-plugin-memory.md | 175 | 2026-04-08 | 0 | 0 | 0 | 0 | 0 | 0 |
| docs/adr/006-command-system.md | 197 | 2026-04-08 | 0 | 0 | 0 | 0 | 1 | 1 |
| docs/adr/007-session-management.md | 238 | 2026-04-08 | 0 | 0 | 0 | 0 | 0 | 0 |
| docs/adr/008-skill-system.md | 316 | 2026-04-08 | 0 | 0 | 0 | 0 | 0 | 0 |
| docs/adr/CHANGELOG.md | 105 | 2026-04-08 | 0 | 0 | 0 | 0 | 0 | 0 |
| docs/adr/FEEDBACK.md | 270 | 2026-04-08 | 0 | 0 | 0 | 0 | 0 | 0 |
| docs/adr/README.md | 60 | 2026-04-08 | 0 | 0 | 0 | 0 | 0 | 0 |

## 失效引用明细（每类最多 25 条）

### gateway/CLAUDE.md
- 已不存在的路径：`gateway/approval.py`, `gateway/file_handler.py`, `gateway/message_formatting.py`, `gateway/platforms/discord.py`, `gateway/platforms/home_assistant.py`, `gateway/platforms/matrix.py`, `gateway/platforms/signal.py`, `gateway/platforms/slack.py`, `gateway/platforms/telegram.py`, `gateway/platforms/whatsapp.py`, `gateway/rate_limit.py`, `tests/gateway/test_discord.py`, `tests/gateway/test_dispatch.py`, `tests/gateway/test_telegram.py`
- 全树无此名的标识符：`WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`

### agent/CLAUDE.md
- 已不存在的路径：`agent/builtin_memory_provider.py`, `agent/smart_model_routing.py`
- 解析不到的点分标识符：`memory_manager.py`, `model_metadata.py`, `prompt_builder.py`, `run_agent.py`

### hermes_cli/CLAUDE.md
- 已不存在的路径：`hermes_cli/cli-config.yaml.example`, `hermes_cli/cli.py`, `hermes_cli/completer.py`, `hermes_cli/history.py`, `hermes_cli/profiling.py`, `hermes_cli/validation.py`
- 解析不到的点分标识符：`cli.py`, `commands.py`, `setup.py`, `skin_engine.py`

### plugins/CLAUDE.md
- 已不存在的路径：`plugins/base.py`, `plugins/config.py`, `plugins/exceptions.py`, `plugins/memory/builtin/__init__.py`, `plugins/memory/holographic/__init__.py`, `plugins/memory/honcho/__init__.py`, `plugins/memory/mem0/__init__.py`, `plugins/registry.py`, `plugins/utils.py`, `tests/plugins/test_builtin_memory.py`, `tests/plugins/test_holographic_memory.py`, `tests/plugins/test_honcho_memory.py`, `tests/plugins/test_mem0_memory.py`, `tests/plugins/test_plugin_manager.py`
- 解析不到的点分标识符：`memory.provider`
- 全树无此名的标识符：`HERMES_MEMORY_PROVIDER`, `HOLOGRAPHIC_API_KEY`

### acp_adapter/CLAUDE.md
- 已不存在的路径：`acp_adapter/logging.py`, `acp_adapter/messages.py`, `acp_adapter/metrics.py`, `acp_adapter/protocol.py`, `acp_adapter/validation.py`, `acp_registry/agent.json`, `tests/acp/test_protocol.py`, `tests/acp/test_server.py`, `tests/acp/test_session.py`, `tests/acp/test_tools.py`
- 全树无此名的标识符：`ACPServer`, `HERMES_ACP_ENABLED`, `HERMES_ACP_HOST`, `HERMES_ACP_PORT`

### cron/CLAUDE.md
- 已不存在的路径：`cron/cli.py`, `cron/config.py`, `cron/executor.py`, `cron/notifier.py`, `cron/parser.py`, `cron/persistence.py`, `tests/cron/test_cron_expr.py`
- 全树无此名的标识符：`CronJob`, `HERMES_CRON_ENABLED`, `HERMES_CRON_TIMEZONE`

### environments/CLAUDE.md
- 已不存在的路径：`environments/__init__.py`, `environments/agent_loop.py`, `environments/benchmarks/file_ops_benchmark.py`, `environments/benchmarks/swe_benchmark.py`, `environments/benchmarks/web_benchmark.py`, `environments/evaluation.py`, `environments/hermes_base_env.py`, `environments/hermes_swe_env/__init__.py`, `environments/hermes_swe_env/hermes_swe_env.py`, `environments/reward_functions.py`, `environments/tool_call_parsers/__init__.py`, `environments/tool_call_parsers/anthropic.py`, `environments/tool_call_parsers/generic.py`, `environments/tool_call_parsers/openai.py`, `environments/trajectory_collector.py`, `tests/environments/test_agent_loop.py`, `tests/environments/test_hermes_base_env.py`, `tests/environments/test_hermes_swe_env.py`, `tests/environments/test_tool_call_parsers.py`
- 全树无此名的标识符：`AgentLoopEnv`, `AtroposTrainer`, `HERMES_RL_MODE`, `HERMES_RL_TRAJECTORY_DIR`, `HermesBaseEnv`, `compute_reward`

### tools/CLAUDE.md
- 已不存在的路径：`tests/tools/test_browser_tool.py`, `tests/tools/test_web_tools.py`, `tools/environments/singularity.py`, `tools/your_tool.py`
- 解析不到的点分标识符：`model_tools.py`, `toolsets.py`
- 全树无此名的标识符：`E2B_API_KEY`

### tests/CLAUDE.md
- 解析不到的点分标识符：`conftest.py`
- 全树无此名的标识符：`HERMES_DEBUG`, `freezegun`, `mock_llm_response`

### docs/adr/001-sync-agent-loop.md
- 已不存在的路径：`async/await`

### docs/adr/002-tool-registry.md

### docs/adr/003-multi-instance.md

### docs/adr/004-prompt-cache.md

### docs/adr/005-plugin-memory.md

### docs/adr/006-command-system.md

### docs/adr/007-session-management.md

### docs/adr/008-skill-system.md

### docs/adr/CHANGELOG.md

### docs/adr/FEEDBACK.md

### docs/adr/README.md
