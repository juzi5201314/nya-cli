# nya-cli

面向 agent 的本地知识库 CLI。

它解决两件事：

1. 把 Git 仓库或网页内容学习进本地知识库
2. 让 agent 以检索或自然语言问答的方式使用这些知识

当前提供两条搜索路径：

- `search`：本地混合检索，适合拿原始命中结果
- `ai-search`：LLM 驱动的自然语言搜索，适合直接拿 grounded answer

## 适用场景

`nya-cli` 适合这些场景：

- 给 coding agent 提供项目代码知识库
- 给 research agent 提供文档站知识库
- 把公网网页或 docs 页面转成本地可检索知识
- 在全局知识库和项目知识库之间切换使用

## 核心能力

当前已实现：

- `learn git`：学习本地或远程 Git 仓库
- `learn web`：学习单页网页，或显式 `--crawl` 学习多页站点
- `search`：`embedding + FTS + RRF` 混合检索
- `ai-search`：LLM 多轮 query planning + 本地证据回答
- `web search`：使用 Tavily 做公网搜索
- `db scope / stats / doctor / rebuild / clear`

当前 provider：

- Embedding：`Google`、`OpenAI`
- LLM：`Google`、`OpenAI`
- Web Search：`Tavily`
- Web Ingest：`Scrapling`

## 快速开始

### 1. 安装前提

需要这些基础依赖：

- `Bun`
- `git`
- `scrapling` CLI

如果你要使用 `learn web` 的动态抓取模式，`scrapling fetch` 还依赖它自己的浏览器环境。

### 2. 安装依赖

```bash
bun install
```

### 3. 安装 Scrapling

如果机器上还没有 `scrapling`：

```bash
uv tool install scrapling
```

确认可执行：

```bash
scrapling --help
```

### 4. 配置密钥

项目根目录使用 `.env`：

```env
GOOGLE_GENERATIVE_AI_API_KEY=...
TAVILY_API_KEY=...
OPENAI_API_KEY=...
CLOUDFLARE_API_TOKEN=...
```

说明：

- `.env` 会在 CLI 启动时自动加载
- 已存在于系统环境里的同名变量不会被 `.env` 覆盖
- 不使用某个 provider 时，可以不填对应 key

### 5. 检查配置文件

主配置文件是 [nya.toml](/home/soeur/project/nya-cli/nya.toml)。

当前配置分层：

- `[web.search]`
- `[web.ingest]`
- `[embedding]`
- `[llm]`
- `[ai_search]`
- `[index]`

说明：

- `web.ingest.provider` 支持 `scrapling`（本机抓取）与 `cloudflare`（Cloudflare Browser Rendering `/crawl`）。
- 使用 `cloudflare` 时，需要在 `nya.toml` 中配置 `[web.ingest.providers.cloudflare].account_id`，并在环境变量中提供 `CLOUDFLARE_API_TOKEN`。

### Provider 速率限制与重试

所有外部 provider 的配置段都支持：

- `rpm` / `tpm`：每分钟请求数 / token 数限制；`0` 表示不限制
- `retry_max_retries`：额外重试次数（不含首次请求），默认 `3`
- `retry_delay_seconds`：每次重试的基础等待时间（秒），默认 `10`

说明：

- 遇到 `429`（速率限制）时，会自动增加等待时间，并在启用重试时额外增加重试次数（默认 +2）。

### 6. 先试一条最短链路

```bash
nya learn git /path/to/repo
nya search "vector search"
nya ai-search "这个仓库的搜索机制是什么？"
```

## 存储作用域

`nya-cli` 有两种数据库作用域：

- **全局数据库**
- **项目数据库**

默认行为：

- `learn` / `search` / `ai-search` 默认使用 **全局数据库**
- 传 `--project` 时使用当前目录下的 `./.nya-cli/index.sqlite`

示例：

```bash
nya learn git /path/to/repo
nya learn git /path/to/repo --project
```

说明：

- 全局数据库用于跨项目复用知识
- 项目数据库用于隔离当前仓库上下文
- 远程 Git 缓存始终是**全局缓存**，不跟随 `--project`

## CLI 用法

说明：

- 默认在交互式终端下会启用 TUI（用于进度条等交互输出）。
- 传入 `--no-tui` 可强制禁用 TUI。
- 传入 `--json` 时会自动禁用 TUI，保证输出简洁、稳定，适合 agent 消费。

### 学习 Git 仓库

学习本地仓库：

```bash
nya learn git /path/to/repo
```

学习远程仓库：

```bash
nya learn git https://github.com/owner/repo.git
```

写入项目数据库：

```bash
nya learn git https://github.com/owner/repo.git --project
```

典型 JSON 输出：

```json
{
  "source": "https://github.com/owner/repo.git",
  "sourceKind": "remote_git",
  "scope": "global",
  "documentsIndexed": 42,
  "chunksIndexed": 215,
  "rebuildTriggered": false
}
```

### 学习网页

学习单个页面：

```bash
nya learn web https://example.com/docs
```

学习多页站点：

```bash
nya learn web https://example.com/docs --crawl --max-pages 20 --max-depth 2
```

抓取模式：

- `--fetch-mode auto`：默认，先 `get`，必要时回退到 `fetch`
- `--fetch-mode get`
- `--fetch-mode fetch`

典型 JSON 输出：

```json
{
  "source": "https://example.com/docs",
  "sourceKind": "web",
  "scope": "global",
  "documentsIndexed": 8,
  "chunksIndexed": 31,
  "crawledPages": 8
}
```

### 重复 learn 行为

你可以重复对同一个 source 执行 `learn`：

- 对同一个 `sourceKey` 会**覆盖写入**（先删除旧数据，再写入新数据），不会累加出两份重复内容。
- 重复执行会重新抓取/读文件并重新做 embedding，成本接近一次全量 `learn`。
- `sourceKey` 是 `db rebuild --source <sourceKey>` 的输入，可用 `nya db scope --global|--project` 查看；注意不同 URL/路径写法可能被当成不同的 source。

### 本地混合检索

```bash
nya search "vector search for agents"
```

JSON 输出：

```bash
nya search "vector search for agents" --json
```

典型结果：

```json
{
  "query": "vector search for agents",
  "results": [
    {
      "path": "README.md",
      "section": "Search",
      "snippet": "Gemini embeddings and Tavily search help agents..."
    }
  ]
}
```

### LLM 驱动自然语言搜索

```bash
nya ai-search "Gemini 和 Tavily 在本地知识库里如何帮助 agent 搜索？"
```

可调参数：

```bash
nya ai-search "你的问题" \
  --max-steps 3 \
  --max-queries 3 \
  --max-evidence 12 \
  --limit 8
```

说明：

- `ai-search` 只搜索**本地知识库**
- 不会主动混入 Tavily 公网搜索结果
- 内部会多轮规划 query，再调用现有 `search` 内核取证据，最后输出带引用的答案

典型 JSON 输出：

```json
{
  "query": "Gemini 和 Tavily 在本地知识库里如何帮助 agent 搜索？",
  "answer": "Gemini embeddings and Tavily search help agents answer questions from the local knowledge base.",
  "usedQueries": [
    "Gemini local knowledge base search agent",
    "Tavily local knowledge base search agent"
  ],
  "citations": [
    {
      "evidenceId": 1,
      "path": "README.md",
      "section": "AI Search Fixture"
    }
  ]
}
```

### 公网搜索

```bash
nya web search "Tavily Gemini embeddings"
```

说明：

- `web search` 只做公网搜索
- 不会写入本地知识库
- 如果你要把网页内容写入知识库，请使用 `learn web`

## 数据库命令

`db` 子命令必须显式指定作用域：

- `--global`
- `--project`

两者必须二选一。

### 查看统计

```bash
nya db stats --global
nya db stats --project --json
```

### 查看数据库与 source 状态

```bash
nya db scope --global
nya db scope --project --json
```

`db scope` 现在会展示：

- 数据库路径
- 全局远程缓存路径
- source 列表
- 每个 source 的最近一次 rebuild 状态

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

控制失败策略：

```bash
nya db rebuild --global --retry 2
nya db rebuild --global --retry 2 --fail-fast
```

当前行为：

- 默认每个 source 最多尝试 `1 + retry` 次
- 失败 source 会被持久化记录到 `source_manifests`
- 如果最终还有失败 source，命令返回非零退出码
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

当前 `search` **不是** LLM 搜索。

它是本地混合检索：

- query embedding
- vector search
- FTS5
- 必要时 LIKE fallback
- RRF 融合

适合：

- 想拿到原始命中 chunk
- 想自己控制后续处理
- 想要更可解释、可预期的检索行为

### `ai-search`

当前 `ai-search` 是有边界的 LLM 驱动搜索：

- planner 生成多轮检索 query
- 每轮复用本地 `search`
- 最后生成 grounded answer 和 citations

适合：

- 直接问自然语言问题
- 需要带证据引用的回答
- 希望 agent 先自己规划检索再回答

## 故障排查

### 1. `scrapling` 不存在

典型报错：

```text
未检测到可用的 scrapling CLI。请先安装 Scrapling CLI。
```

处理方式：

```bash
uv tool install scrapling
scrapling --help
```

### 2. `scrapling fetch` 找不到浏览器

典型报错会包含：

```text
Playwright ... Executable doesn't exist ...
playwright install
```

原因：

- `scrapling fetch` 依赖 Playwright 浏览器二进制
- 你安装了 Scrapling，但还没有把浏览器装好

处理方式：

先安装 Playwright 浏览器依赖，再重试 `learn web --fetch-mode fetch`。

如果当前页面用 `get` 就够用，也可以先继续使用：

```bash
nya learn web https://example.com/docs --fetch-mode get
```

### 3. `learn web --fetch-mode auto` 回退到 `fetch`

`auto` 模式下会先尝试 `get`。

如果出现这些情况，会回退到 `fetch`：

- 请求失败
- 正文抽取失败
- 正文过短

如果你不想触发浏览器抓取，可以显式指定：

```bash
nya learn web https://example.com/docs --fetch-mode get
```

### 4. `db` 子命令报作用域错误

典型报错：

```text
db 子命令必须显式指定且只能指定一个作用域：--global 或 --project
```

处理方式：

必须显式传其中一个：

```bash
nya db stats --global
nya db scope --project
```

### 5. `db rebuild --failed-only` 没有任何动作

原因通常是：

- 当前没有失败状态的 source
- 你已经把失败 source 修复并成功重建过了

先看状态：

```bash
nya db scope --global --json
```

关注：

- `failedSourceManifests`
- 每个 manifest 的 `lastRebuildStatus`

### 6. `db rebuild --source ...` 拒绝执行

如果当前 embedding fingerprint 变了，并且库里有多个 source，系统会拒绝只重建单个 source。

原因：

- 避免新旧向量空间混用

处理方式：

先重建整个 scope：

```bash
nya db rebuild --global
```

### 7. `db rebuild` 结束但退出码非零

这说明：

- 至少有一个 source 最终失败
- 命令虽然继续处理了其他 source，但整体不算完全成功

处理方式：

先查看失败列表：

```bash
nya db rebuild --global --json
```

然后只重试失败项：

```bash
nya db rebuild --global --failed-only
```

### 8. `ai-search` 比 `search` 慢很多

这是预期行为。

原因：

- `ai-search` 不是单次检索
- 它要跑多轮 LLM planning + retrieval + answer synthesis

如果你更看重速度或原始命中结果，优先用：

```bash
nya search "your query"
```

### 9. `ai-search` 没有命中公网信息

这是预期行为。

`ai-search` 当前只搜索本地知识库，不会主动去调 Tavily。

如果你需要公网搜索：

```bash
nya web search "your query"
```

或者先把网页 learn 进本地库，再跑 `ai-search`。

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

构建产物默认输出到：

```text
dist/nya
```
