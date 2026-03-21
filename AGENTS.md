# nya-cli AGENTS

## 项目定位

`nya-cli` 是一个面向 agent 的本地知识库 CLI。

当前项目已经不是只有“learn + search”两条链路，而是包含：

1. `learn`：从 Git 仓库或 Web 页面抽取内容，清洗、分块、向量化并写入本地索引库
2. `search`：本地混合检索，返回适合继续处理的命中结果
3. `get`：按路径或 `documentId` 读取整页文档 / 完整代码文件
4. `ai-search`：LLM 驱动的本地 grounded answer
5. `web search`：调用公网搜索 provider
6. `db`：查看、诊断、重建、清空数据库

本项目采用 hard cutover，默认不做向后兼容，除非用户明确要求。

## 当前技术栈

- Runtime / Package Manager：`Bun`
- Language：`TypeScript`（ESM）
- CLI：`cac`
- TUI / 交互输出：`ink`、`react`、`@clack/prompts`
- Validation：`zod`
- AI Model Access：`ai`、`@ai-sdk/openai`、`@ai-sdk/google`
- Database：`SQLite`
- Vector Index：`sqlite-vec`
- Keyword Search：`SQLite FTS5`
- HTML 正文抽取：`@mozilla/readability`
- HTML 解析：`linkedom`
- Markdown 转换：`turndown`
- Logging：优先标准输出，需要时使用 `pino`
- Code Chunking：`web-tree-sitter`、`@repomix/tree-sitter-wasms`
- Testing：`bun test`
- Lint / Format：`biome`
- Type Check：`tsc --noEmit`
- Build：`bun build`

## 当前已实现的 Provider 边界

项目当前已经明确拆分了 `web.search` 与 `web.ingest`，不要再把两者混成一个含糊的 `web provider`。

### `web.search`

- 当前仅支持 `tavily`
- 用于公网搜索
- 命令入口：`nya web search <query>`

### `web.ingest`

- 当前支持 `scrapling`、`cloudflare`
- 用于网页学习 / 抓取，不用于公网搜索
- 命令入口：`nya learn web <url>`

### `embedding`

- 当前支持 `openai`、`google`
- 用于本地索引写入与查询向量化

### `llm`

- 当前支持 `openai`、`google`
- 用于 `ai-search` 的 query planning 与答案生成

### `rerank`

- 当前固定为 `none`
- 不要提前设计复杂 rerank 抽象或兼容层，除非用户明确要求

## 架构约束

### Web 能力与本地检索必须分离

项目内固定区分两层：

1. `Web Search / Web Ingest`
2. `Local Retrieval Engine`

禁止把 `nya search` 和 `nya web search` 设计成同一个概念。

### 多供应商实现保持克制

- provider 通过显式注册表创建
- 每层只保留窄接口
- provider 私有配置放在各自命名空间
- 不要实现运行时插件发现
- 不要为了统一而抹掉供应商特有能力

### 数据层保持简单直接

- 本地存储固定为 `SQLite + sqlite-vec + FTS5`
- 默认不引入 ORM
- 优先原生 SQL 或极薄的数据访问层

### 向量索引必须绑定 fingerprint

embedding fingerprint 至少包含：

- `provider`
- `model`
- `dimensions`
- `task_type`
- `chunking_version`

硬性规则：

- fingerprint 变化时必须自动重建本地索引
- 不允许混写不同 embedding 空间的数据
- 不允许为了兼容旧索引加入临时兼容分支

## 当前内容处理策略

### Git 学习

- 优先直接调用系统 `git`
- 支持本地仓库与远程仓库
- 跳过二进制、lockfile、构建产物和超大文件
- 代码文件优先使用 `Tree-sitter` 分块

### Web 学习

- 支持单页抓取与多页 crawl
- 单页和 crawl 都会先转正文 Markdown 再进入 chunking
- `scrapling` 负责本机抓取
- `cloudflare` 负责 Browser Rendering / Crawl API 路径

### 本地检索

默认流程：

1. `vector search`
2. `FTS search`
3. `RRF` 融合

`ai-search` 在此基础上增加多轮 query planning 与证据约束回答。

## 当前命令面

已实现且应被视为稳定命令面：

- `nya learn git <repo>`
- `nya learn web <url>`
- `nya search <query>`
- `nya get [path]`
- `nya ai-search <query>`
- `nya web search <query>`
- `nya db scope`
- `nya db stats`
- `nya db doctor`
- `nya db rebuild`
- `nya db clear --yes`

命名约束：

- `nya search` 只表示本地知识库检索
- `nya web search` 只表示公网搜索
- 不要重新引入歧义命名

## 当前配置模型

主配置文件为 `nya.toml`。

当前稳定配置分层：

- `[app]`
- `[web.search]`
- `[web.ingest]`
- `[embedding]`
- `[llm]`
- `[ai_search]`
- `[index]`

约束：

- provider id 必须显式声明
- secrets 默认从环境变量读取
- provider 私有字段放在 `*.providers.<id>` 下
- 新增配置项时，优先延续现有 TOML 结构，不要再发散出第二套格式

## 当前数据作用域

项目现在支持两种数据库作用域：

- `global`
- `project`

规则：

- 默认使用全局数据库
- `--project` 使用当前目录下 `./.nya-cli/index.sqlite`
- 远程 Git 缓存当前始终是全局缓存，不跟随 `--project`

## 当前目录结构

以当前实现为准：

```text
src/
  cli/
  commands/
  config/
  core/
    chunking/
    ingest/
    search/
  db/
  providers/
  tui/
  types/
  utils/
scripts/
tests/
```

## 开发命令

- 开发运行：`bun run src/index.ts`
- 构建：`bun run build`
- 测试：`bun test`
- 类型检查：`tsc --noEmit`
- 全量检查：`bun run check`

## 编码约束

- 保持模块边界清晰，避免单文件过大
- 避免过早抽象，优先小而稳的接口
- 注释使用简体中文，解释关键流程与难点
- 删除废弃代码，不保留兼容分支
- 核心逻辑必须可测试
- 不要引入 LangChain、LlamaIndex 作为主架构依赖，除非用户明确要求
- 不要引入外部托管向量数据库，除非用户明确要求
- 不要把 Web 搜索与本地检索揉进同一个抽象

## 修改 AGENTS.md 时的要求

如果后续继续更新本文件，遵循这几个原则：

- 优先记录“已经实现并生效”的事实，不写长篇路线图
- 新增命令、provider、配置分层后及时同步这里
- 如果 README 与 AGENTS 冲突，以代码现状为准并同时修正文档
