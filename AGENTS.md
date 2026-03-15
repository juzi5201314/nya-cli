# nya-cli AGENTS

## 项目定位

`nya-cli` 是一个面向 agent 的知识库 CLI。

核心能力只有两条主链路：

1. `learn`：从 Git 仓库或 Web 文档抽取内容，清洗、分块、向量化，并写入本地索引库。
2. `search`：从本地索引库检索相关内容，返回适合 agent 消费的结果。

本项目采用 hard cutover，默认不做向后兼容，除非用户明确要求。

## 总体架构原则

本项目默认采用 ** 分层多供应商架构 **。

也就是说，所有真正可能被替换的外部能力，都应以 provider adapter
方式接入；但不要为了“看起来很灵活”提前做复杂插件系统。

默认需要支持多供应商的层：

- `Web Provider`：公网搜索、抽取、站点发现、抓取
- `Embedding Provider`：文本向量化
- `Rerank Provider`：重排，可选
- `LLM Provider`：总结、回答、查询改写，可选

默认支持名单：

- `web.provider`：`tavily`
- `embedding.provider`：`openai`、`google`
- `llm.provider`：`openai`、`google`
- `rerank.provider`：首版允许 `none`，后续再接真实供应商

默认不要求首版就做多供应商的层：

- `Local Store`：首版固定 `SQLite`
- `Vector Index`：首版固定 `sqlite-vec`
- `Keyword Search`：首版固定 `FTS5`

原因：

- 这些本地组件是项目内核，不是外部 SaaS 供应商。
- 首版先把 provider 变化集中在真正高频变动的外部能力上。
- 避免把每一层都抽成接口后却只有一个实现，徒增复杂度。

## 默认技术栈

除非用户明确要求变更，否则统一使用以下技术栈：

- Runtime / Package Manager：`Bun`
- Language：`TypeScript`（ESM）
- CLI：`cac`
- Interactive Prompt：`@clack/prompts`
- Validation：`zod`
- AI Model Access：`ai` + provider packages（优先 `@ai-sdk/openai` 或 openai-compatible provider）
- Web Search / Crawl Provider：provider adapter 抽象，首个实现为 `Tavily`
- Config Format：`TOML`
- Database：`SQLite`
- Vector Index：`sqlite-vec`
- Keyword Search：`SQLite FTS5`
- HTML 内容抽取：`@mozilla/readability`
- HTML 解析：`linkedom`
- Markdown 转换：`turndown`
- Logging：优先标准输出；需要结构化日志时使用 `pino`
- Testing：`bun test`
- Lint / Format：`biome`
- Type Check：`tsc --noEmit`
- Build / Release：`bun build`

## 技术选型原则

### AI SDK

`AI SDK` 适合作为本项目的模型接入层，原因如下：

- 统一 embeddings / rerank / chat 能力，便于后续切换 provider。
- Bun 可直接使用，依赖负担可接受。
- 对 agent 场景友好，后续若要接 tool calling 或 provider registry，不需要推倒重来。

但要注意：

- `AI SDK` 只负责模型调用，不负责索引架构设计。
- 分块、清洗、去重、入库、检索排序必须在项目内自行实现。
- 不要把核心检索逻辑外包给高层 RAG framework。

`AI SDK` 的定位是 ** 多供应商模型接入层 **。

默认用于承载这些 provider 类型：

- `Embedding Provider`
- `Rerank Provider`（如后续选用支持 rerank 的 provider）
- `LLM Provider`

当前默认支持：

- `Embedding Provider`：`openai`、`google`
- `LLM Provider`：`openai`、`google`

不要用它来承载：

- `Tavily` 这类 Web search / crawl provider
- 本地 SQLite / 向量库 / FTS 检索

### Web Provider 抽象

外部 Web 能力与本地知识库检索必须拆开建模，不要共用一个含糊的 `search` 概念。

从现在开始，项目内固定分成两层：

1. `Web Provider`：面向公网搜索、抓取、抽取、站点发现
2. `Local Retrieval Engine`：面向本地 SQLite 向量库和 FTS 检索

首个 `Web Provider` 固定支持 `Tavily`。

默认不要通过 `AI SDK` 适配 `Tavily`，而是直接使用 Tavily 官方 SDK 或原生 HTTP 接口。

原因：

- `Tavily` 不是 embedding / LLM provider，而是 Web intelligence provider。
- `search_depth`、`topic`、`include_raw_content`、`include_domains` 等参数具有明显 Tavily 特性。
- 直接适配官方接口，更容易保留 credits、request_id、rate limit 等调试信息。

后续如果扩展多供应商，保持同一套 adapter 形状即可，首选能力为：

- `search(query, options)`
- `extract(urls, options)`
- `crawl(url, options)`
- `map(url, options)`

### 多供应商边界

从现在开始，代码设计上默认允许以下 provider id 存在：

- `web.provider`
- `embedding.provider`
- `rerank.provider`
- `llm.provider`

但实现策略必须克制：

- 每层只定义一个窄接口
- 每层先做一个默认实现
- 第二家供应商落地后再补通用能力交集
- 不要先做动态插件发现和运行时加载

推荐做法：

- provider 通过显式注册表创建
- 配置文件选择 provider id
- provider-specific 参数放入各自命名空间
- 公共参数只保留真正跨供应商稳定的字段

禁止做法：

- 用一个超级大 `ProviderConfig` 承载所有供应商字段
- 为了统一而抹掉 Tavily 这类 provider 的关键能力
- 让 provider 返回一堆 `any`

### 数据层

默认选择 `SQLite + sqlite-vec + FTS5`，不引入外部向量数据库。

原因：

- 单机 CLI 场景下部署最简单。
- 本地文件数据库便于迁移、备份、调试和离线使用。
- 向量检索与关键词检索可统一在一个文件内完成。

默认不使用 ORM。优先原生 SQL 或极薄的数据访问层。

原因：

- `sqlite-vec` 和 FTS5 都偏 SQL 特性，ORM 反而容易增加复杂度。
- 当前 schema 简单，没必要引入重型抽象。

### 向量索引生命周期

向量索引必须绑定明确的 embedding fingerprint，至少包含：

- `provider`
- `model`
- `dimensions`
- `task_type`
- `chunking_version`

如有额外影响向量可比性的参数，也必须纳入 fingerprint。

硬性规则：

- 只要 embedding fingerprint 发生变化，就 ** 自动重建 ** 本地向量索引
- 不允许把新旧 embedding 混写到同一索引
- 不允许在查询时临时兼容多个不兼容 embedding 空间

默认行为：

1. 启动或执行 `learn` 前读取当前配置 fingerprint
2. 与本地索引 metadata 中记录的 fingerprint 比较
3. 如不一致，自动触发重建流程
4. 重建完成后再继续写入或查询

实现要求：

- 自动重建应当是默认行为，不要求用户手动执行额外命令
- 重建过程必须更新索引 metadata
- CLI 输出必须明确告知“因 embedding model 变更正在重建索引”
- 若未来需要保留历史索引，也应通过新 index id 隔离，而不是混用

## 默认检索策略

默认采用混合检索。

注意：这里说的“检索”只指 ** 本地知识库检索 **，不包括 Tavily 这类公网搜索。

本地检索流程如下：

1. 先做 `vector search`
2. 再做 `FTS keyword search`
3. 使用 `RRF` 或等价融合策略合并结果
4. 如用户需要更高精度，再接入 rerank

默认不要一开始就上复杂多阶段 pipeline。

## 默认内容处理策略

### Git 仓库

- 优先直接调用系统 `git` 命令，不使用 JS git SDK。
- 只读取需要的 revision / branch。
- 抽取时保留源码路径、标题、语言、提交信息等 metadata。
- 默认跳过明显无价值内容：二进制文件、lockfile、构建产物、超大文件。

### Web 文档

- 优先抓取正文内容，而不是整页 HTML。
- 页面统一清洗后转为 Markdown 再进入 chunking。
- 保留来源 URL、标题、抓取时间、canonical URL。
- 默认支持单页抓取与 sitemap / docs 导航扩展。

## 默认 chunking 规则

除非用户明确要求，不要先上复杂语义分块器。

默认策略：

- 优先按 Markdown 标题层级分段
- 再按段落 / 列表 / 代码块边界切块
- 控制 chunk 大小稳定，避免过碎或超长
- 相邻 chunk 保留少量 overlap
- metadata 中保留 source、path、section、token_estimate

## 命令设计原则

命令输出必须同时兼顾人类和 agent：

- 默认输出简洁文本
- 重要命令必须支持 `--json`
- 错误输出必须稳定、可解析

建议优先实现这些命令：

- `nya learn git <repo>`
- `nya learn web <url> --provider tavily`
- `nya web search <query> --provider tavily`
- `nya search <query>`
- `nya db stats`
- `nya db doctor`

命名约束：

- `nya search` 保留给本地知识库检索。
- 外部公网搜索统一走 `nya web search`。
- 不要让 `search` 一词同时指代 Tavily 搜索和本地向量检索。

## 配置规范

配置文件统一使用 `TOML`。

默认文件名：

- 项目级配置：`nya.toml`
- 用户级配置：后续如需支持，可使用 `~/.config/nya/config.toml`

首版优先只支持一个显式配置文件路径和项目根 `nya.toml`，不要先做多级合并地狱。

配置设计原则：

- 顶层只放稳定的全局开关
- 每个 provider 拥有独立命名空间
- secrets 优先从环境变量读取，配置文件只保存引用名或非敏感默认值
- provider id 必须显式可见，不做隐式猜测

推荐结构：

```toml
[app]
data_dir = ".nya"
default_output = "text"

[web]
provider = "tavily"

[web.providers.tavily]
api_key_env = "TAVILY_API_KEY"
default_topic = "general"
default_search_depth = "basic"

[embedding]
provider = "google"
model = "gemini-embedding-001"

[embedding.providers.google]
api_key_env = "GOOGLE_GENERATIVE_AI_API_KEY"
output_dimensionality = 1536
task_type = "RETRIEVAL_DOCUMENT"

[embedding.providers.openai]
api_key_env = "OPENAI_API_KEY"
base_url = "https://api.openai.com/v1"
dimensions = 1536

[rerank]
provider = "none"

[llm]
provider = "google"
model = "gemini-2.5-flash"

[llm.providers.google]
api_key_env = "GOOGLE_GENERATIVE_AI_API_KEY"

[llm.providers.openai]
api_key_env = "OPENAI_API_KEY"
base_url = "https://api.openai.com/v1"

[index]
chunk_size = 1200
chunk_overlap = 150
fts = true
vector = true
```

说明：

- `provider = "none"` 用于显式关闭某一可选层，如 `rerank`
- 各层都允许未来扩展第二家供应商
- provider 私有字段放在 `*.providers.<id>` 下，避免污染公共配置
- `google` 是默认受支持 provider，不代表必须作为默认启用项
- 切换 `embedding.provider`、`embedding.model`、`dimensions`、`task_type` 或 `chunking_version` 时，必须自动重建向量索引

## 建议目录结构

```text
src/
  cli/
  commands/
  core/
    ingest/
    chunking/
    search/
  db/
  providers/
  parsers/
  types/
  utils/
migrations/
tests/
fixtures/
```

## 编码约束

- 保持模块边界清晰，避免单文件过大。
- 避免过早抽象，先做小而稳的接口。
- 除非是性能热点，不要引入复杂框架。
- 注释使用简体中文，解释关键流程与难点。
- 删除废弃代码，不保留兼容分支。
- 优先可测试设计，核心逻辑必须可单测。

## 实施边界

当用户只是在讨论方案、评审选型、比较技术路线时，不要直接开始大规模编码。

当用户明确要求开始实现时，优先顺序如下：

1. 初始化 Bun + TypeScript 项目骨架
2. 建立 `nya.toml` 配置加载与 schema 校验
3. 建立 provider adapter 抽象，先接 `Tavily`、`OpenAI`、`Google`
4. 建立 SQLite schema、index metadata 与 fingerprint 校验机制
5. 打通 embedding fingerprint 变更后的自动重建流程
6. 打通最小可用 `learn git` 链路
7. 打通最小可用 `nya web search` 与 `nya search` 两条链路
8. 再扩展 `learn web`

## 禁止事项

- 不要默认引入 LangChain / LlamaIndex 作为主架构依赖。
- 不要默认接外部托管向量数据库。
- 不要为了“未来也许会用到”提前设计复杂插件系统。
- 不要实现向后兼容层，除非用户明确要求。
- 不要把 Tavily 这种公网搜索 provider 和本地知识库检索写成同一个抽象。
- 不要把配置格式同时做成 TOML + YAML + JSON。
- 不要在 embedding model 切换后继续复用旧向量索引。
