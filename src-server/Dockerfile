# 构建上下文须为仓库根（docker-compose.prod.yml: build.context: "."）——
# src-server 通过 path 依赖 ../crates/llm-wiki-parser，仅以 src-server/ 作上下文
# 会缺 crate（cargo: failed to get `llm-wiki-parser`）。
# rust:1.77 读不了 lockfile v4（需 cargo ≥1.78）；1.97 与本地开发工具链一致
FROM rust:1.97-slim-bookworm AS builder
WORKDIR /app/src-server
RUN apt-get update && apt-get install -y pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
# 依赖层缓存：先只拷清单 + stub 源全量构建一次（含 path 依赖 parser 的空 lib）
COPY src-server/Cargo.toml ./Cargo.toml
COPY src-server/Cargo.lock ./Cargo.lock
COPY crates/llm-wiki-parser/Cargo.toml /app/crates/llm-wiki-parser/Cargo.toml
RUN mkdir -p src tests/integration /app/crates/llm-wiki-parser/src \
    && echo "fn main() {}" > src/main.rs \
    && echo "" > tests/integration/mod.rs \
    && echo "" > /app/crates/llm-wiki-parser/src/lib.rs
RUN cargo build --release
RUN rm -rf src /app/crates/llm-wiki-parser/src
COPY src-server/src ./src
COPY crates/llm-wiki-parser/src /app/crates/llm-wiki-parser/src
# COPY 保留 checkout 旧 mtime（早于 stub 层）→ cargo 指纹误判"无需重建"、拿 stub
# 版 parser/lib 链接（parse_bytes 缺失）。touch 推高 mtime 强制重建本层两个包。
RUN touch src/main.rs src/lib.rs /app/crates/llm-wiki-parser/src/lib.rs \
    && cargo build --release

FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y ca-certificates libssl3 poppler-utils && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /app/src-server/target/release/llm-wiki-server /app/llm-wiki-server
COPY src-server/migrations /app/migrations
EXPOSE 8080
CMD ["/app/llm-wiki-server"]
