← [CLAUDE.md](../CLAUDE.md)

## 🚀 运行与开发

### 环境要求

- **Node.js**: 20+
- **Rust**: 1.70+ (2021 edition)
- **操作系统**: macOS, Windows, Linux

### 开发模式

```bash
# 安装依赖
npm install

# 启动开发服务器 (前端 Vite + Tauri)
npm run tauri dev
# 前端热重载端口: 1420

# 前端单独运行 (端口 1420)
npm run dev

# 运行测试
npm test

# Rust 代码检查
cargo clippy
cargo fmt
```

### 生产构建

```bash
# 构建前端
npm run build

# 构建 Tauri 应用
npm run tauri build

# 生成的安装包位置:
# - macOS: src-tauri/target/release/bundle/dmg/
# - Windows: src-tauri/target/release/bundle/msi/
# - Linux: src-tauri/target/release/bundle/deb/ 或 .AppImage
```

### Chrome 扩展安装

1. 打开 `chrome://extensions`
2. 启用"开发者模式"
3. 点击"加载已解压的扩展程序"
4. 选择项目的 `extension/` 目录

---

## 🧪 测试策略

### 测试框架

- **单元测试**: Vitest@4.1.4
- **测试位置**: `src/lib/__tests__/`
- **当前覆盖**: 仅 LLM provider 配置测试

### 运行测试

```bash
# 运行所有测试
npm test

# 监听模式（开发时推荐）
npm run test -- --watch

# 查看覆盖率
npm run test -- --coverage

# Rust 测试
cargo test
```

### 测试覆盖缺口

- ❌ ingest.ts 单元测试（两步摄取流程、SHA256 缓存）
- ❌ search.ts 单元测试（分词、图扩展、预算控制）
- ❌ wiki-graph.ts 单元测试（图谱构建、Louvain、相关性计算）
- ❌ embedding.ts 单元测试（向量嵌入、搜索）
- ❌ graph-relevance.ts 单元测试（四信号模型）
- ❌ Rust 后端集成测试（文件操作、向量存储）
- ❌ E2E 测试（摄取 → 搜索 → 聊天流程）
- ❌ UI 组件测试（React Testing Library）

---

## 📐 编码规范

### TypeScript/JavaScript

- **风格指南**: 遵循 ESLint 默认配置
- **类型安全**: 严格使用 TypeScript 类型
- **组件命名**: PascalCase for components, camelCase for utilities
- **文件组织**: 按功能模块分组 (components/, lib/, stores/)

### Rust

- **版本**: 2021 edition
- **风格**: `cargo fmt` (rustfmt)
- **Linter**: `cargo clippy`
- **错误处理**: 使用 `Result<T, String>` 返回错误信息给前端

### 代码质量工具

- **前端**: ESLint + TypeScript
- **后端**: rustfmt + clippy
- **CI/CD**: GitHub Actions (多平台构建测试)

