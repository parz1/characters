# 旧执行契约存档：Session / Run / worker

归档日期：2026-10-25。以下保留 v0.1 写作执行方向的历史设计，部分仍未实现。它不定义当前插件式产品的交付范围，也不能作为新增功能的实施依据。

当前主线见[系统设计](design.md)、[统一契约](contracts.md)、[第一阶段计划](phase-1.md)和[Codex 插件设计](codex-plugin.md)。已有执行试用的实际用法见[Codex 试用](codex.md)，实际结构以 packages/core/src/schemas.ts 为准。

下文的“不需要常驻服务”“第一阶段不提供 MCP”“每个 worker 只处理一个 Run”等仅适用于旧执行方向，不约束新的管理服务或 MCP 网关。

本文定义第一阶段的数据、CLI 与适配器边界。P1、P2 与 Codex 最小闭环已实现结构、角色管理、作品操作、事务恢复及基础会话；长期记忆和通用执行协议仍是后续实现契约。示例中的 TypeScript 解释领域字段，实际类型由 packages/core/src/schemas.ts 推导。持久记录使用 UTF-8 JSON，适合手工编辑的角色与工作区入口使用 YAML，正文使用 Markdown。

## 通用规则

- schemaVersion 是整数格式版本；角色 version 是角色内容版本，二者独立。
- 内部 ID 使用带类型前缀的 UUID，例如 ses_、run_、work_、mem_、msg_、src_、prop_、snap_。角色 ID 使用小写 kebab-case。
- 时间使用带时区的 ISO 8601 UTC 字符串；显示时转换为用户时区。
- revision 为从 1 开始递增的整数，写入检查 expectedRevision。
- 内容摘要为原始文件字节的 SHA-256；包摘要基于排序后的 POSIX 相对路径和各文件摘要生成规范 JSON 后再计算。
- 持久记录只保存工作区相对引用，不保存临时机器绝对路径。外部来源可保存公开 URL，但不得包含认证信息。
- 对未知 schemaVersion 拒绝写入；迁移必须显式执行，保留备份，第一阶段只支持版本 1。
- first-party CLI 不扫描 HOME 推断工作区，也不把当前目录自动当成数据写入目的地。除 help 外，工作区命令显式传入 --workspace。

## 角色包

```yaml
schemaVersion: 1
id: koto
name: koto chan
version: 0.1.0
languages: [cn, ja, en]
defaultLanguage: cn
files:
  persona: persona.md
  voice: voice.md
  relationships: relationships.md
modes:
  conversation: modes/conversation.md
  coauthor: modes/coauthor.md
examples:
  good: examples/good.md
  bad: examples/bad.md
contextKeys: [people/parz1, projects/kotolog]
```

包不能包含可执行钩子、凭证、私有经历或宿主工具权限。入口只能引用包内文件，contextKeys 是工作区背景的逻辑键，不是任意文件路径。安装时验证引用、语言、大小及摘要，并复制到工作区的包快照目录。

characters.lock 保存安装包的 characterId、version、digest 和清单路径。同版本不同 digest 必须拒绝隐式替换。第一阶段只支持本地目录安装，不处理下载、市场、压缩包或自动更新。

## 工作区

```yaml
schemaVersion: 1
id: ws_example
timezone: Asia/Tokyo
policy:
  isolation: strict
  memoryWrite: confirm
  network: adapter-only
  tools: [source.read]
runtime:
  adapter: stdio
  command: local-character-worker
  args: []
  environmentAllowlist: []
  contextBudget:
    maxUtf8Bytes: 48000
    maxOutputUtf8Bytes: 32000
```

ID 示例仅示意，实际初始化生成带 ws_ 前缀的 UUID。P1 初始化将 adapter 设为 unconfigured 并省略 command，不自动启用 stdio。fake 和 stdio 是为后续接入保留的配置分支；只有 stdio 允许且要求 command。

48000 字节是初始可配置上限，不是通用模型 token 上限；适配器还要检查自己的 token 或请求限制。必需上下文超限返回 CONTEXT_LIMIT。

network: adapter-only 表示 Core 没有网页抓取工具，模型适配器可访问其明确配置的服务。它不代表机器的出站网络已经被操作系统阻断。

工作区引用的可执行文件必须来自本地可信配置，使用 executable 与 args 启动，禁止 shell 拼接。导入角色包不能修改此配置。凭证只通过白名单注入执行子进程，不写回 YAML。

## 作品与来源

```ts
interface WorkRecord {
  schemaVersion: 1
  id: string
  revision: number
  title: string
  language: 'cn' | 'ja' | 'en'
  kind: 'post' | 'log' | 'crap'
  attribution: {
    mode: 'human' | 'character' | 'dialogue'
    authors: string[] // 如 person:parz1、character:koto
    contributors: string[]
  }
  stage: 'discussion' | 'outline' | 'draft' | 'review' | 'ready'
  publication?: { slug: string; description?: string; published: string }
  contentRevision: number
  contentDigest: string // 当前 revision.json 的 SHA-256
  createdAt: string
  updatedAt: string
}

interface SourceRecord {
  id: string
  kind: 'user-note' | 'file' | 'url-snapshot' | 'message'
  title: string
  snapshotRef: string
  digest: string
  origin?: string
  messageRef?: { sessionId: string; messageId: string }
  capturedAt: string
  visibility: 'private' | 'publishable'
}
```

sources.json 保存 SourceRecord 数组，实际正文存入工作区内部的不可变内容对象，以 snapshotRef 引用。文件和粘贴内容在导入时复制；URL 第一阶段仅作为来源标注，必须同时提供本地摘录文件，不自动访问 URL。来源可以引用原消息，但快照必须保留对应原文。

作品每一版包含完整 brief、sources、outline、draft 和 revision.json。版本清单保存该版元数据、四份正文摘要与 previousDigest，work.json 的 contentDigest 锚定当前版本。revision 和 contentRevision 在 P2 同步递增，元数据修改也保存完整版本。

proposal 声明 baseRevision、origin、目标文档、sourceIds 和建议全文。origin 为 `{ type: 'user' }`，或未来模型运行的 `{ type: 'run', sessionId, runId }`。P2 只提供用户建议稿入口，不伪造 Run。Core 仅允许建议稿修改 outline 或 draft；修改署名、brief、来源使用 work update。模型不能直接设置 ready。

work update --patch 接受经过 schema 验证的 JSON：可修改 title、attribution、stage、publication，也可通过 briefSourceId 指定该作品已导入的文本 sourceId 来替换 brief。外部文件需先使用 work source add 导入，不解释 JSON 内的任意磁盘路径。source visibility 的更改使用 sourceVisibility 映射，键必须是该作品已有 sourceId。

work create 初始 stage 为 discussion，正文与 brief 为空；author 参数可重复，单一 character 作者默认 attribution.mode 为 character，多人署名必须显式选择 mode。导出日期校验为 datetime，slug 校验为 kebab-case。

## 会话与运行

```ts
interface SessionRecord {
  schemaVersion: 1
  id: string
  revision: number
  character: { id: string; version: string; digest: string }
  mode: 'conversation' | 'coauthor'
  language: 'cn' | 'ja' | 'en'
  workId?: string
  status: 'open' | 'closed'
  lastMessageSequence: number
  activeRunId?: string
  createdAt: string
  updatedAt: string
}

interface RunRecord {
  schemaVersion: 1
  id: string
  sessionId: string
  parentRunId?: string // 显式重试或继续的来源
  status: 'prepared' | 'running' | 'completed' | 'failed' | 'interrupted'
  adapterId: string
  adapterVersion: string
  model?: string
  contextSnapshotId: string
  capabilityEvidenceId: string
  isolationRequested: 'strict' | 'relaxed'
  isolationEffective: 'strict' | 'relaxed'
  startedAt?: string
  endedAt?: string
  errorCode?: string
  resultDigest?: string
  owner?: { pid: number; host: string }
}

interface MessageRecord {
  id: string
  sequence: number
  sessionId: string
  role: 'user' | 'character'
  characterId?: string
  runId?: string
  text: string
  createdAt: string
}
```

Session 必须满足 coauthor 时存在 workId。Message 的 sequence 在会话内唯一递增。第一阶段不允许替换既有消息；修正以新消息表达。

session close 仅在没有活动 Run 时成功，保留数据并将状态设为 closed。session resume 把 closed 转为 open，或继续原本 open 的会话；只准备恢复摘要，不自动调用模型。send 才创建新 Run。session stop 取消当前 Run，不改变会话 open 状态。

恢复时使用锁定角色包和当前作品版本，明确列出上一次运行之后的作品变化。默认选择当前已确认记忆，历史 Run 保留当时的输入；恢复不是重放旧快照。

## 记忆

```ts
interface MemoryRecord {
  schemaVersion: 1
  id: string
  revision: number
  characterId: string
  kind: 'fact' | 'event' | 'opinion' | 'relationship' | 'preference'
  status: 'candidate' | 'confirmed' | 'rejected' | 'superseded' | 'retracted'
  content: string
  tags: string[]
  visibility: 'private' | 'publishable'
  occurredAt?: string
  recordedAt: string
  sources: Array<
    | { type: 'message'; sessionId: string; messageId: string }
    | { type: 'source'; workId: string; sourceId: string }
    | { type: 'user-statement'; statementRef: string }
  >
  replaces?: string
  decisions: Array<{
    action: 'confirm' | 'reject' | 'supersede' | 'retract'
    actor: 'user'
    at: string
    reason?: string
  }>
}
```

至少一个来源必填。默认 visibility 为 private；publishable 只表示可以考虑用于公开作品，不自动公开记录或原始聊天。实际导出须由用户审阅私人细节，程序只检查可结构化验证的条件。

状态转换如下：

```text
candidate ──confirm──> confirmed ──retract──> retracted
    └──────reject───> rejected
confirmed + 新候选的确认 ──同一事务──> 旧条目 superseded，新条目 confirmed
```

propose 可由模型提议或用户显式发起；confirm、reject、retract 只接受用户命令。对于缺少可验证来源的推断，只能记录为 opinion 或待确认材料，不能声称它是事实。

retract 是停止使用，不是删除隐私数据。第一阶段不提供保证彻底删除的命令；历史 input 快照可能包含旧条目。正式实现数据清除时须覆盖原文、派生索引、快照、导出和备份策略。

## 上下文快照

```ts
interface ContextSnapshot {
  schemaVersion: 1
  id: string
  sessionId: string
  workRevision?: number
  characterDigest: string
  policyDigest: string
  createdAt: string
  entries: Array<{
    sourceId: string
    kind:
      | 'policy'
      | 'persona'
      | 'mode'
      | 'context'
      | 'memory'
      | 'message'
      | 'work'
      | 'example'
    digest: string
    reason: string
    utf8Bytes: number
    truncated: boolean
  }>
  excluded: Array<{ sourceId: string; reason: string }>
  inputDigest: string
  inputRef: string
}
```

context explain 展示来源与选择理由，默认不打印完整私人正文；context show --input 是显式查看实际输入。快照由 Core 创建，不能接受适配器伪造的输入清单。

## CLI

命令名为 characters。帮助文本与人类输出用中文，稳定 JSON 键和错误码用英文。P2 已实现 workspace init/status/recover、character add/list/show，以及 work create/show/update/source add/proposal add/proposal list/apply。Codex 最小闭环还实现 session open/send/show/list/close/resume/run 和 adapter doctor，见 docs/codex.md；context、memory、跨进程 session stop、通用适配器与 export 命令仍未实现。

| 命令                                                                                                        | 语义                                       |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| workspace init PATH                                                                                         | 创建新工作区；非空目录默认拒绝             |
| workspace status                                                                                            | 查看数据版本、恢复状态和策略               |
| workspace recover                                                                                           | 安全恢复后返回状态                         |
| character add PATH                                                                                          | 校验并安装本地角色包                       |
| character list / show ID                                                                                    | 查看已安装角色与版本                       |
| work create --title TEXT --author character:koto --lang cn --kind log [--mode character]                    | 创建作品，生成 ID                          |
| work show ID [--revision N]                                                                                 | 查看当前作品或校验后的历史版本             |
| work update ID --patch FILE --expect-revision N                                                             | 更新允许的作品元数据与 brief               |
| work source add ID --file FILE --title TEXT [--origin URL] [--visibility publishable] [--expect-revision N] | 导入来源快照，默认 private                 |
| session open --character koto [--work ID] --mode coauthor --lang cn                                         | 创建会话，不启动模型                       |
| session list / show ID                                                                                      | 查看会话与恢复信息                         |
| session send ID --file FILE                                                                                 | 导入用户消息并执行一次 Run                 |
| session resume ID                                                                                           | 恢复会话状态和进度，不调用模型             |
| session stop ID                                                                                             | 请求取消活动 Run                           |
| session close ID                                                                                            | 无活动 Run 时结束会话                      |
| context explain RUN_ID                                                                                      | 查看实际选择的上下文清单                   |
| context show RUN_ID --input                                                                                 | 查看保存的实际输入                         |
| work proposal list ID                                                                                       | 查看该作品的建议修改                       |
| work proposal add ID --file FILE --expect-revision N                                                        | 导入用户建议稿，不修改正文                 |
| work apply ID --proposal ID --expect-revision N                                                             | 将建议稿应用为新作品版本                   |
| memory propose --character ID --file FILE --source-message SES_ID:MSG_ID [--replaces ID]                    | 创建候选条目                               |
| memory list --character ID [--status confirmed]                                                             | 查询当前角色的指定状态记忆                 |
| memory show ID                                                                                              | 查看来源、状态和决定历史                   |
| memory confirm / reject / retract ID --expect-revision N                                                    | 用户明确改变记忆状态                       |
| adapter doctor                                                                                              | 检查协议、宿主版本、配置与隔离证据         |
| export work ID --format markdown [--slug TEXT] [--published DATETIME]                                       | 导出当前作品到 exports，默认不覆盖已有输出 |

除 workspace init PATH、全局 help 外，以上命令必须提供 --workspace PATH。带外部 FILE 的命令由用户显式授权读取，先复制为内部快照；模型工具不能复用这些入口读取外部任意文件。

以下示例中 workspace、character 与 work create 已可用；session 与 context 命令展示后续预期体验：

```powershell
characters workspace init D:/writing/kotolog
characters character add ./characters/koto --workspace D:/writing/kotolog
characters work create --title '博客作者系统' --author character:koto --lang cn --kind log --workspace D:/writing/kotolog
# 后续 ID 使用上一步输出的真实 ID，以下占位符需要替换
characters session open --character koto --work WORK_ID --mode coauthor --lang cn --workspace D:/writing/kotolog
characters session send SESSION_ID --file ./topic.txt --workspace D:/writing/kotolog
characters context explain RUN_ID --workspace D:/writing/kotolog
```

所有命令支持 --json；stdout 输出一个结果封装 `{ ok, data, error }`，进度和脱敏诊断写 stderr。第一阶段不提供连续交互 REPL，不需要常驻服务。send 在前台运行，Ctrl+C 与 stop 都执行取消流程。

memory propose 的 FILE 为 JSON，包含 kind、content、tags 和可选 visibility；其来源由 --source-message 显式关联。work update 的 patch 为局部字段替换，不采用任意 JSON Patch 路径。session send 仅接受 UTF-8 文本。直接 CLI 输入的记忆正文会复制为内部对象，并与所指消息共同保存来源。

session send、work apply 和 memory confirm 支持 --request-id UUID；Core 保存请求指纹，重复同请求返回原结果或当前状态。同一 requestId 携带不同内容返回 CONFLICT；失败 Run 的重试使用新 requestId 与 --retry-of RUN_ID，不能暗中重复生成。

退出码：0 成功；2 参数或 schema 错误；3 未找到；4 版本冲突或忙；5 隔离或权限拒绝；6 适配器错误；7 数据或恢复错误；130 用户取消。

错误码至少包含 INVALID_INPUT、NOT_FOUND、CONFLICT、BUSY、ISOLATION_UNSUPPORTED、PERMISSION_DENIED、CONTEXT_LIMIT、ADAPTER_PROTOCOL、ADAPTER_FAILED、ADAPTER_TIMEOUT、STORE_CORRUPT、RECOVERY_REQUIRED、CANCELLED。错误输出提供对象 ID、可执行的下一步，不输出凭证或完整输入。

## 适配器接口

```ts
type Support = 'supported' | 'unsupported' | 'unknown'

interface AdapterCapabilities {
  protocolVersion: 1
  adapterId: string
  adapterVersion: string
  hostVersion: string
  freshExecution: Support
  hostMemory: 'disabled' | 'session-scoped' | 'global' | 'unknown'
  toolBoundary: 'enforced' | 'none' | 'unknown'
  defaultConfigDiscovery: 'controlled' | 'unknown'
  cancellation: Support
  providerRetention: 'configured' | 'unknown'
  evidence: {
    id: string
    verifiedAt: string
    validUntil: string
    hostBinaryDigest: string
    configurationDigest: string
    suiteVersion: string
    result: 'pass' | 'fail' | 'unverified'
  }
}

interface ExecutionRequest {
  protocolVersion: 1
  runId: string
  sessionId: string
  work?: { id: string; revision: number }
  input: {
    digest: string
    messages: Array<{ role: 'system' | 'user' | 'assistant'; text: string }>
  }
  isolation: 'strict' | 'relaxed'
  tools: Array<{ name: 'source.read'; schemaVersion: 1 }>
  allowedSourceIds: string[]
  limits: {
    timeoutMs: number
    maxOutputUtf8Bytes: number
    maxToolCalls: number
  }
  // 不提供整个工作区路径或任意磁盘访问句柄
}

type AdapterEvent = {
  runId: string
  sequence: number
} & (
  | { type: 'started' }
  | { type: 'text'; delta: string }
  | {
      type: 'tool-request'
      requestId: string
      name: 'source.read'
      sourceId: string
    }
  | {
      type: 'proposal'
      proposal: {
        target: 'outline' | 'draft'
        baseRevision: number
        content: string
        sourceIds: string[]
      }
    }
  | {
      type: 'memory-candidate'
      candidate: {
        kind: MemoryRecord['kind']
        content: string
        sourceIds: string[]
      }
    }
  | { type: 'completed'; text: string }
  | { type: 'failed'; code: string; message: string }
)

interface CharacterAdapter {
  probe(): Promise<AdapterCapabilities>
  run(
    request: ExecutionRequest,
    tools: ToolGateway,
    signal: AbortSignal,
  ): AsyncIterable<AdapterEvent>
}

interface ToolGateway {
  readSource(request: {
    runId: string
    requestId: string
    sourceId: string
  }): Promise<
    | { ok: true; text: string; digest: string }
    | { ok: false; code: string; message: string }
  >
}
```

完成文本是 completed.text 的值；text 事件仅用于进度显示，不可重复拼入最终消息。每个 Run 只允许一个 started 和一个终结事件；终结后禁止继续事件。事件必须匹配 runId，sequence 严格递增，超限或非法事件使 Run 失败。

模型提出的 proposal 与 memory-candidate 由 Core 校验并分配对象 ID。来源只能引用此次授权的 sourceId 或消息 ID，不接受任意路径。第一阶段工具只有 source.read，所有写入通过建议和用户命令完成。

ToolGateway 由 Core 实现，强制检查当前 Run 的 allowedSourceIds、次数及字节限制。适配器把 tool-request 事件用于审计，再通过 gateway 取得结果，不能因事件被记录就视为已经获准。stdio 驱动层将 worker 的工具请求转成 gateway 调用并回传结果；拒绝同一 requestId 的重复执行。

### stdio 传输

stdio 是本地适配器协议，不假设任意 Agent CLI 能直接理解它。对具体宿主需要一个符合协议的 worker，负责翻译请求与事件。

使用 UTF-8 JSON Lines，首轮握手为 hello 与 capabilities；Core 通过 request 消息发送 ExecutionRequest，worker 输出 event 消息。工具调用由 Core 回传 tool-result，包含 requestId、ok 和允许的内容；取消发送 cancel 后等待终结，超时终止受管进程树。

线上的消息封装固定如下，未知 type 或不支持的 protocolVersion 均失败：

```text
Core → worker  { type: "hello", protocolVersion: 1 }
worker → Core  { type: "capabilities", data: AdapterCapabilities }
Core → worker  { type: "request", data: ExecutionRequest }
worker → Core  { type: "event", data: AdapterEvent }
Core → worker  { type: "tool-result", runId, requestId, data: ToolGatewayResult }
Core → worker  { type: "cancel", runId }
```

ToolGatewayResult 为 readSource 返回的判别联合。每个 worker 进程只接受一个 Run；下一次 send 重新启动。取消后的 worker 可以报告 failed/CANCELLED，Core 归一化为 interrupted。

worker 的 stdout 只能承载协议，stderr 仅写诊断。Core 对单条消息大小、总输出、空闲超时、工具次数和总运行时间设上限。真实运行默认总超时 180 秒、取消宽限 5 秒，这些是初始配置值。

Core 创建每次运行独立的执行目录及配置目录，默认不继承工作目录和全部环境；凭证按白名单单独注入。能力检查发现宿主存在不可控的其他配置入口时 strict 拒绝。

### 能力验证

probe 声明不足以证明隔离。doctor 核对经过测试的宿主版本、二进制摘要、启动参数与配置摘要，隔离验证证据过期或环境变化即要求重新检查。证据默认有效期为 24 小时，每次运行仍重新核对环境摘要；24 小时不是隐私保证。检查过程不得修改真实全局记忆。

fake 适配器验证 Core 协议、隔离拒绝和恢复逻辑，不属于真实 Agent 隔离证据。第一阶段结束必须有一个具体宿主 worker 的真实验收；在此之前系统状态只能是“模拟闭环已通过”。

## 导出约定

Markdown 导出包含 title、slug、kind、lang、可选 description、author 和 published 等博客所需元数据。slug 与 published 必须由用户在 publication 字段中提供或导出命令显式指定；不从自然语言 brief 猜测，也不把生成时间默认为发布日期。author 使用稳定 ID koto，显示名由博客作者资料解析。对话共作保留作者数组，需要博客后续支持；第一阶段的博客验收使用单作者 Koto。

导出要求作品 stage 为 ready，检查必填字段、来源状态和署名。设置 ready 前展示作品引用的 private 来源和使用过的私人上下文，由用户完成内容审阅；Core 不能自动证明正文没有私人细节。后续任何正文、来源或署名变更都会取消 ready 状态，需要重新审阅。导出文件旁保存对应作品版本、引用来源与导出参数的清单。

默认目标为工作区 exports 的唯一文件名，不向博客目录直接写入，也不提交 Git。生成候选稿时应列出引用的 sourceId，无法验证的引用必须标记待确认，不能靠模型自报“没有引用私密内容”绕过审阅。

当前博客仍需在 content schema 和页面署名中接入 author；导出成功不等于博客已支持角色作者。适配博客的功能独立实施。
