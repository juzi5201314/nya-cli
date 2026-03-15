# nya-cli

面向 agent 的知识库 CLI。

`nya-cli` 现在提供两条搜索路径：

- `search`：本地知识库混合检索，走 `embedding + FTS + RRF`
- `ai-search`：LLM 驱动的自然语言搜索，只搜索本地知识库

同时支持两类学习入口：

- `learn git`：学习本地或远程 Git 仓库
- `learn web`：学习单个网页，或显式 `--crawl` 学习多页站点

## 介绍

项目目标是给 agent 提供一个可本地运行、可重建、可多供应商扩展的知识库工具。

当前核心能力：

- 本地存储：`SQLite + sqlite-vec + FTS5`
- Embedding provider：`Google`、`OpenAI`
- LLM provider：`Google`、`OpenAI`
- Web search provider：`Tavily`
- Web ingest provider：`Scrapling`

当前作用域模型：

- 默认写入 **全局数据库**
- 使用 `--project` 写入 **当前项目数据库**，路径是 `./.nya-cli/index.sqlite`
- 远程 Git 缓存始终在全局 cache 目录，不跟随 `--project`

## 安装

### 运行前提

需要这些基础依赖：

- `Bun`
- `git`
- `scrapling` CLI

如果你要使用 `learn web` 的动态抓取模式，`scrapling fetch` 还依赖它自己的浏览器环境。

### 安装项目依赖

```bash
bun install
```

### 安装 Scrapling

如果你的机器还没有 `scrapling`：

```bash
uv tool install scrapling
```

安装后可以确认：

```bash
scrapling --help
```

## 配置

### `.env`

项目根目录可以放 `.env`，CLI 启动时会自动加载。

至少建议填写：

```env
GOOGLE_GENERATIVE_AI_API_KEY=...
TAVILY_API_KEY=...
OPENAI_API_KEY=...
```

说明：

- 已存在于系统环境里的同名变量不会被 `.env` 覆盖
- 如果不用某个 provider，可以不填对应 key

### `nya.toml`

项目配置文件名固定为 `nya.toml`。

当前配置分层：

- `[web.search]`
- `[web.ingest]`
- `[embedding]`
- `[llm]`
- `[ai_search]`
- `[index]`

默认示例见 [nya.toml](/home/soeur/project/nya-cli/nya.toml)。

## CLI 用法

### 学习 Git 仓库

学习本地仓库：

```bash
nya learn git /path/to/repo
```

学习远程仓库：

```bash
nya learn git https://github.com/owner/repo.git
```

写入当前项目数据库：

```bash
nya learn git https://github.com/owner/repo.git --project
```

### 学习网页

学习单个页面：

```bash
nya learn web https://example.com/docs
```

显式启用多页 crawl：

```bash
nya learn web https://example.com/docs --crawl --max-pages 20 --max-depth 2
```

抓取模式：

- `--fetch-mode auto`：默认，先 `get`，必要时回退到 `fetch`
- `--fetch-mode get`
- `--fetch-mode fetch`

### 本地混合检索

```bash
nya search "vector search for agents"
```

JSON 输出：

```bash
nya search "vector search for agents" --json
```

### LLM 驱动自然语言搜索

```bash
nya ai-search "Gemini 和 Tavily 在本地知识库里如何帮助 agent 搜索？"
```

可调参数：

```bash
nya ai-search "你的问题" --max-steps 3 --max-queries 3 --max-evidence 12 --limit 8
```

说明：

- `ai-search` 只搜索本地知识库
- 不混入 Tavily 公网搜索结果
- 它会多轮规划 query，然后调用现有 `search` 内核取证据，最后输出带引用的答案

### 公网搜索

```bash
nya web search "Tavily Gemini embeddings"
```

## 数据库命令

`db` 子命令必须显式指定作用域：

- `--global`
- `--project`

两者必须二选一。

### 查看数据库统计

```bash
nya db stats --global
nya db stats --project --json
```

### 查看数据库与 source 状态

```bash
nya db scope --global
nya db scope --project --json
```

### 重建数据库

重建当前作用域全部 source：

```bash
nya db rebuild --global
```

只重建一个 source：

```bash
nya db rebuild --global --source <sourceKey>
```

只重试上次失败的 source：

```bash
nya db rebuild --global --failed-only
```

控制重试策略：

```bash
nya db rebuild --global --retry 2
nya db rebuild --global --retry 2 --fail-fast
```

行为说明：

- 默认每个 source 最多尝试 `1 + retry` 次
- 失败 source 会被记录到 manifest 中
- 如果有失败 source，命令最终返回非零退出码
- `--failed-only` 只会处理 `lastRebuildStatus = "failed"` 的 source

### 清空数据库

```bash
nya db clear --project --yes
```

说明：

- `db clear` 是危险操作
- 必须显式传 `--yes`
- 只清当前作用域数据库，不清全局远程 Git 缓存

## 当前实现说明

### `search`

当前 `search` 不是 LLM 搜索。

它是本地混合检索：

- query embedding
- vector search
- FTS5
- 必要时 LIKE fallback
- RRF 融合

### `ai-search`

当前 `ai-search` 是有边界的 LLM 驱动搜索：

- planner 生成多轮检索 query
- 每轮复用本地 `search`
- 最后生成 grounded answer 和 citations

它不会主动调用公网搜索。

## 开发

### 检查

```bash
bun run typecheck
bun test
bunx biome check .
```

### 构建

```bash
bun run build
```

产物默认输出到：

```text
dist/nya
```
