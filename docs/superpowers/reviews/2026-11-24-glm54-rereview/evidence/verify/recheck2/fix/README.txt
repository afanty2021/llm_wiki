11.3 修复清单（11-25 晚）的沙箱验证脚本与原始输出——归档自 /tmp/glm54-fix-20261125（易失），拷贝时间 2026-11-26 05:12:10。
原件按运行原样归档，唯一改动：scripts/audit-sandbox.py 有一行 docstring 含 3 处教师企微 id，归档副本换成代称（/tmp 原件未动）。
对应关系：nail-final-verify.py → raw/nail-final.out、summary-nail-final.txt（11.3-1 回归钉：基线 10 过、19 变异体全红）；
  audit-sandbox.py → raw/audit-sandbox.txt（11.3-3a 巡检脚本沙箱 36 项）；audit-live.py → raw/audit-live.txt（只读重放 + 受护 live --dry-run，id 掩码）；
  watchdog-sandbox.py → raw/watchdog-sandbox.txt（11.3-3b 看门第 6 查沙箱 14 项）。*.out 是 stdout/stderr 原样，*.txt 是脚本自写的汇总。

原件 sha256（前 16 位）与大小：
  scripts/audit-live.py  6250B  06642eb3bbfd6121  真实id命中=0
  scripts/audit-sandbox.py  21231B  dcab1b6a318bc4eb  真实id命中=3
  scripts/nail-final-verify.py  3220B  db2593b9a4359a0b  真实id命中=0
  scripts/watchdog-sandbox.py  10824B  53bdb1bc1c6f544d  真实id命中=0
  raw/audit-live.txt  1082B  21087e0c1bb53772  真实id命中=0
  raw/audit-sandbox.out  7635B  20246951c09fe758  真实id命中=0
  raw/audit-sandbox.txt  7635B  20246951c09fe758  真实id命中=0
  raw/nail-final.out  12786B  5c1d49f7cf192feb  真实id命中=0
  raw/summary-nail-final.txt  12779B  0b429b15feb06cde  真实id命中=0
  raw/watchdog-sandbox.out  3298B  f90e58fc18b51441  真实id命中=0
  raw/watchdog-sandbox.txt  3298B  f90e58fc18b51441  真实id命中=0

【11-26 续做轮（定时任务，05:10 起）追加——原件在 /tmp/glm54-fix-20261126/（易失）】
scripts/mutate.py → raw/mutation-matrix.txt：11.3-2 web-clip 小修批的变异矩阵（kill 类 17 个全杀、等价类 2 个按预期存活、替代修法 1 个按设计红）。
raw/base-build.out、base-test-prod.out：改动前基线（副本构建与 live dist 同字节；344 = 343 过 / 1 跳）。
raw/fix-full-3.out、fix-full-local.out：修后全量（生产 node 26.12.1 与本机 26.13.0 均 353 = 352 过 / 1 跳）；raw/net-stab-*.out：网络测试文件稳定性抽 3 遍。
raw/test-mocks-final.out：最终工作树的 test:mocks（2598 例 / 182 文件，2597 过、1 败——败的是本机 ffmpeg 起不来那条，与改动无关，见 report §十一 11.9）。
raw/ci-sim-summary.txt 及 ci-sim-*、assert-mut-*：CI check 同款三步（桌面构建 → build:web → 形态断言）与断言脚本的 4 个变异；copy-dist.sha 对 live-dist.sha：副本 build:web 与 live dist/ 221 文件零差异。
raw/ci-sim-mcp-test.out：CI frontend-test 同款 npm run mcp:test（353 = 352 过 / 1 跳）。raw/base-build.out、base-test-prod.out 是改动前基线的构建与测试输出。
归档副本的又一处改动：base-test-prod.out、fix-full-3.out、fix-full-local.out、ci-sim-mcp-test.out 里有一条测试标题带教师企微 id（仓内 mcp-server/test/worksheet.test.ts 的测试名），归档副本换成代称 TeachX（/tmp 原件未动）。scripts/sync.sh、run.sh、repo-copy.sh：副本同步、跑测与建树脚本（单向，只读 live 仓）。
拷入时间 2026-11-26 05:36:28。
