# tools/books — 书籍拆章流水线（Task 7）

英语教学法知识库的书籍摄取前置工具：把整本 PDF 按章拆分为 ≤40k token 预算的章节
PDF + `manifest.json`，供 Task 8（MinerU 解析）/ Task 9（摄取）消费。

---

## 1. 先决检查结论（Step 1，2026-08-23）

| 检查项 | 命令 | 结果 |
|---|---|---|
| 本地 mineru-api 是否在跑 | `lsof -i :8000 -sTCP:LISTEN` | 无监听（端口空闲） |
| 8000 端口 API 探测 | `curl -s http://127.0.0.1:8000/docs` | 无响应 |
| 桌面端 mineru 云 token 配置 | `grep -ri mineru ~/Library/Application\ Support/com.llmwiki.app/app-state.json` | 无任何配置 |

**结论（用户已裁定）**：采用 **本地 Docker（mineru-api，端口 8000）**；云端 token 方案
保留为 TODO（见 §2.4）。本任务已把本地 API 部署并验证通过（§2.3）。

## 2. MinerU 本地 Docker 部署

### 2.1 为什么是自制镜像（重要决策）

- MinerU **官方没有发布预构建 Docker 镜像**（[opendatalab/MinerU#1845](https://github.com/opendatalab/MinerU/issues/1845)），
  官方仅提供 Dockerfile（[docker/global/Dockerfile](https://github.com/opendatalab/MinerU/blob/master/docker/global/Dockerfile)），
  其基底为 `vllm/vllm-openai`（CUDA），**仅支持 Linux / Windows WSL2 + NVIDIA GPU**，
  官方文档明确 macOS 不可用（Docker 无法访问 MPS/MLX）。
- 本机为 macOS Apple Silicon（无 NVIDIA GPU），故按官方 Dockerfile 同款做法改用
  **官方 PyPI 包 `mineru[core]==3.4.5` + 官方入口 `mineru-api --host 0.0.0.0 --port 8000`**
  （与官方 `docker/compose.yaml` 的 `api` 服务完全一致的 API 面），pipeline 后端 CPU 推理。
- 镜像源码：本目录 [`Dockerfile.mineru`](./Dockerfile.mineru)。

### 2.2 构建 + 运行（复现命令）

```bash
# 构建（依赖 ~6GB，含 torch；国内镜像源见 Dockerfile.mineru 头注，海外用 --build-arg 换回官方源）
cd tools/books
docker build -f Dockerfile.mineru -t mineru-api:local-cpu .

# 运行（仅绑定 127.0.0.1；named volume 缓存模型权重，容器重建不重下）
docker run -d --name mineru-api \
  -p 127.0.0.1:8000:8000 \
  -v mineru-models-cache:/root/.cache \
  --restart unless-stopped \
  mineru-api:local-cpu
```

### 2.3 验证（本任务实测，2026-08-23）

```bash
$ curl -s http://127.0.0.1:8000/health
{"status":"healthy","version":"3.4.5","protocol_version":2,"queued_tasks":0,
 "processing_tasks":0,"completed_tasks":0,"failed_tasks":0,
 "max_concurrent_requests":3,"processing_window_size":64,...}

$ curl -s http://127.0.0.1:8000/docs | head -3      # → Swagger UI HTML（200）
$ curl -s http://127.0.0.1:8000/openapi.json | jq '.paths|keys'
["/file_parse","/health","/tasks","/tasks/{task_id}","/tasks/{task_id}/result"]
```

- 镜像实测 `mineru-api:local-cpu` 6.01GB（linux/arm64，torch 为默认 CUDA 版 wheel，
  内含的 nvidia 库为死重、不生效——`MINERU_DEVICE_MODE=cpu` 强制 CPU）。
- 同步解析端点 `POST /file_parse`，异步 `POST /tasks` + `GET /tasks/{id}`（Task 8 用）。
- 模型权重在**首次解析时**按需下载（`MINERU_MODEL_SOURCE=modelscope`）并缓存于
  `mineru-models-cache` volume——Task 8 第一次跑会先下模型。
- CPU pipeline 解析扫描版书籍较慢（估计每页数十秒），Task 8 做整书 418 页时需分章
  批量、可断点续跑（按 manifest 逐章）。
- **解析后端可配**：`books.json` 的 `local.backend`（默认 `"hybrid-engine"`，docker 部署
  不用改）。**宿主 MPS 部署**（mineru-api 直接跑在 macOS 宿主）实测 hybrid-engine 慢/不可用，
  设 `"backend": "pipeline"`（配合 parse_method auto/ocr）约快 15×。

### 2.4 宿主 MPS 部署（推荐路径，实测 ~15× 于 docker CPU；2026-08-24 定型）

模型权重**持久缓存于 `~/.modelscope`**（勿再落 /tmp——macOS 重启即清，2026-08-24 事故实证）。
`books.json`：`mode: "local"`、`local.baseUrl: "http://127.0.0.1:8002"`、`local.backend: "pipeline"`。

```bash
# 模型下载（一次性/增量补齐；pipeline 全套 ~2.4GB）
MODELSCOPE_CACHE=~/.modelscope MINERU_MODEL_SOURCE=modelscope \
  /opt/homebrew/Caskroom/miniconda/base/envs/mineru-mps/bin/mineru-models-download -s modelscope -m pipeline

# 起 API（端口对齐 books.json 的 8002；MPS 设备自动探测，hybrid-engine 在 MPS 慢/不可用）
MODELSCOPE_CACHE=~/.modelscope MINERU_MODEL_SOURCE=modelscope \
  /opt/homebrew/Caskroom/miniconda/base/envs/mineru-mps/bin/mineru-api --host 127.0.0.1 --port 8002
```

- conda env：`mineru-mps`（py3.12，宿主 PyTorch Metal）；运行时经 `MODELSCOPE_CACHE` 读同一目录，下载与解析共用。
- 吞吐实测 ~80s/章（LT 纯扫描书，pipeline + parse_method auto/ocr）。

### 2.5 TODO：云端 token 方案（未采用，留档）

MinerU 也提供云端 API（token 计费，`MINERU_API_BASE`/`MINERU_API_KEY` 环境变量）。
若未来本地 CPU 速度不可接受，可在桌面 app 配置中加 token 走云端；本流水线 Task 8
只依赖 `http://127.0.0.1:8000` 这一个端点，切换云端只需改 base URL。

## 3. 拆章脚本 `split_chapters.py`

依赖：`pypdf`（本机已装 6.7.0：`pip3 install --user pypdf`，Homebrew Python 3.14）。

```bash
# 优先：用 PDF 自带书签 outline（--top-level-only 只取顶层章）
python3 tools/books/split_chapters.py <book.pdf> <out_dir> <book_slug> [--top-level-only]

# 书签缺失/异常时：人工页区间表（from/to 为 PDF 1 起始页码）
python3 tools/books/split_chapters.py <book.pdf> <out_dir> <book_slug> --ranges ranges.json
```

- 产出 `<out_dir>/<slug>/ChNN-<ascii-slug>[-pN].pdf` + `manifest.json`
  （`chapters[]: file/title/from_page/to_page/est_tokens`）。
- token 预算 40k：`pypdf` 提取每页字符数 /4 估算，超预算且可分则二分为 `-p1/-p2`。

## 4. LT 书实跑记录（Learning Teaching 3rd Edition）

- 源 PDF：`/Users/berton/Github/L T师训 2024-2025（HEVC）/…/教学法知识库配套书籍/Learning Teaching 3rd Edition 2.pdf`（418 页，注意路径含空格与 CJK，须引号）。
- **书签异常**：outline 存在但为 418 个伪书签（标题 `'0'..'417'`，每页一个），不可用
  → 走 `--ranges` 人工表（`/tmp/books/lt-ranges.json`，内容见下表）。
- **纯扫描件**：全书 418 页均无文本层（每页一张 JPEG2000 图）→ `est_tokens` 全为 0，
  40k 预算二分不触发。已按"每章 ≤38 页 ≈ OCR 后 ~25k token"人工控区间，均低于预算；
  Task 8 OCR 后若实测超 40k 再对单章补拆。
- **页码偏移**：打印页码 +1 = PDF 页码（四点目验：PDF10=印9 Ch1、PDF124=印123 Ch6、
  PDF286=印285 Ch12、PDF381=印380 Ch16）。
- 实跑输出：`/tmp/books/LT-LearningTeaching-3rd/`（19 个章节 PDF + manifest.json，
  覆盖 PDF pp.1-418 无缝无重叠，页数与 manifest 逐一核对通过）。

### LT 书人工区间表（--ranges JSON，PDF 页码）

| # | 标题 | PDF 页 | 打印页 |
|---|---|---|---|
| Ch01 | Frontmatter (Contents, Foreword, Introduction) | 1–9 | –8 |
| Ch02 | Chapter 1 Starting out | 10–37 | 9–36 |
| Ch03 | Chapter 2 Classroom activities | 38–54 | 37–53 |
| Ch04 | Chapter 3 Classroom management | 55–82 | 54–81 |
| Ch05 | Chapter 4 Who are the learners? | 83–99 | 82–98 |
| Ch06 | Chapter 5 Language analysis | 100–123 | 99–122 |
| Ch07 | Chapter 6 Planning lessons and courses | 124–156 | 123–155 |
| Ch08 | Chapter 7 Teaching grammar | 157–185 | 156–184 |
| Ch09 | Chapter 8 Teaching lexis | 186–211 | 185–210 |
| Ch10 | Chapter 9 Productive skills: speaking and writing | 212–249 | 211–248 |
| Ch11 | Chapter 10 Receptive skills: listening and reading | 250–271 | 249–270 |
| Ch12 | Chapter 11 Phonology: the sound of English | 272–285 | 271–284 |
| Ch13 | Chapter 12 Focusing on language | 286–310 | 285–309 |
| Ch14 | Chapter 13 Teaching different classes | 311–334 | 310–333 |
| Ch15 | Chapter 14 Using technology | 335–349 | 334–348 |
| Ch16 | Chapter 15 Tools, techniques, activities | 350–380 | 349–379 |
| Ch17 | Chapter 16 Next steps | 381–394 | 380–393 |
| Ch18 | Backmatter 1: Answers to tasks and key terminology | 395–406 | 394–405 |
| Ch19 | Backmatter 2: Further reading and index | 407–418 | 406–416 |

`ranges.json` 格式（可直接拷回 `/tmp/books/lt-ranges.json` 复跑）：

```json
[
  {"title": "Frontmatter (Contents, Foreword, Introduction)", "from": 1, "to": 9},
  {"title": "Chapter 1 Starting out", "from": 10, "to": 37},
  {"title": "Chapter 2 Classroom activities", "from": 38, "to": 54},
  {"title": "Chapter 3 Classroom management", "from": 55, "to": 82},
  {"title": "Chapter 4 Who are the learners?", "from": 83, "to": 99},
  {"title": "Chapter 5 Language analysis", "from": 100, "to": 123},
  {"title": "Chapter 6 Planning lessons and courses", "from": 124, "to": 156},
  {"title": "Chapter 7 Teaching grammar", "from": 157, "to": 185},
  {"title": "Chapter 8 Teaching lexis", "from": 186, "to": 211},
  {"title": "Chapter 9 Productive skills: speaking and writing", "from": 212, "to": 249},
  {"title": "Chapter 10 Receptive skills: listening and reading", "from": 250, "to": 271},
  {"title": "Chapter 11 Phonology: the sound of English", "from": 272, "to": 285},
  {"title": "Chapter 12 Focusing on language", "from": 286, "to": 310},
  {"title": "Chapter 13 Teaching different classes", "from": 311, "to": 334},
  {"title": "Chapter 14 Using technology", "from": 335, "to": 349},
  {"title": "Chapter 15 Tools, techniques, activities", "from": 350, "to": 380},
  {"title": "Chapter 16 Next steps", "from": 381, "to": 394},
  {"title": "Backmatter 1: Answers to tasks and key terminology", "from": 395, "to": 406},
  {"title": "Backmatter 2: Further reading and index", "from": 407, "to": 418}
]
```

## 5. Task 8/9 消费接口

`/tmp/books/LT-LearningTeaching-3rd/manifest.json`：

```json
{
  "book": "LT-LearningTeaching-3rd",
  "total_pages": 418,
  "chapters": [
    {"file": "Ch02-chapter-1-starting-out.pdf", "title": "Chapter 1 Starting out",
     "from_page": 10, "to_page": 37, "est_tokens": 0}
    // …19 章
  ]
}
```

`est_tokens=0` 是扫描件无文本层所致（非预算超标）；Task 8 MinerU OCR 产文后按实文
长度复核预算。
