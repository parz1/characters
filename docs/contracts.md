# characters 统一契约

版本：接入协议 v1，设计 v0.3，2026-11-05。实现状态只在[实现状态](status.md)维护；实际 CLI 见 service.md、memory.md 和 mcp.md。

持久/执行 schema 来自 packages/core/src/schemas.ts；packages/protocol 提供请求、响应、版本协商、MCP 映射、预算与 strict 准入。下列 Binding、ConnectionGrant、HostEvidence、ContextDelivery 等是新对象，不复用旧 Session / Run，持久结构由 Core 校验，协议复用这些领域 schema。

原 Work、Session、Run、执行适配器与 JSONL worker 设计保存在[旧执行契约](legacy-execution-contracts.md)；实际已实现命令见[Codex 试用](codex.md)与 CLI help。当前产品边界以[系统设计](design.md)为准。

## 版本与共同规则

- 协议版本、持久 schemaVersion、插件版本、角色包版本分别管理。
- 新 ID 前缀 conn_、bind_、acc_ 已加入 Core ID 校验器；快照沿用 snap_，记忆沿用 mem_。前缀支持不代表对应持久模型或命令已经实现。
- 时间使用 UTC ISO 8601；revision 从 1 递增。内容摘要使用原始 UTF-8 字节 SHA-256，集合使用有定义的规范 JSON。
- 运行时严格校验请求，拒绝未知操作、未知字段和不支持的协议版本。角色名、路径、HostSession ID、MCP session ID 均不是认证凭证。
- 操作不接受工作区路径。服务启动绑定一个 WorkspaceHandle，鉴权后的调用方只能在该工作区内操作；用户管理 CLI 才接收显式 --workspace。
- 每次请求校验身份和范围。角色或记忆 ID 仅作为引用，Core 强制核对归属，不能通过 ID 查询其他角色的私有数据。
- 传输响应统一 `{ ok, data, error }`，失败的 data 为 null，成功的 error 为 null。原始异常、凭证和输入正文不进入错误输出。

## 服务与本地鉴权

首版服务采用 Node 本地 HTTP，监听 `127.0.0.1:0`，路由 `POST /v1/rpc`。只接受有界 application/json 请求；不提供匿名健康检查、远程监听或浏览器跨域访问。服务状态由经过鉴权的管理 CLI 查询。

启动流程：验证工作区并恢复 P2 事务 → 取得独立服务 owner 标记 → 建立回环监听 → 安全写入运行描述符。描述符包括端点、世代 ID、PID/主机、协议版本和本地凭证引用；可移植领域记录不存机器绝对路径。POSIX 使用私有目录/文件权限，Windows 使用仅当前用户与 SYSTEM 的 ACL，不能只依赖 chmod。

用户通过管理端显式创建 ConnectionGrant，并把最小权限凭证交给指定网关配置。凭证由网关读取受保护的本地文件；不放进角色设定、模型可见参数、MCP 工具结果、普通 CLI 输出或日志。服务保存校验摘要和撤销状态；管理凭证与 agent 凭证分开。插件不能读取或转发服务管理凭证。

请求使用 Authorization 头鉴权；服务验证 Host 精确匹配当前回环地址和端口，拒绝浏览器 Origin。MCP 网关只读取用户配置的本地服务描述符，拒绝外部 URL/重定向，不自动回退到 CLI 本地写入，也不执行请求提供的命令。stdio stdout 只输出 MCP，诊断写 stderr。

服务重启改变世代并使旧活动绑定失效，读取凭证仍须在有效授权下重新建立绑定；不自动恢复活动角色。主机/PID 未知时保留 owner 现场。停止网关只关闭连接，不能停止其他用户正在使用的管理服务。

这是可信本地单用户接入；同用户恶意进程可访问宿主权限允许的文件，不属于该凭证方案能防御的范围。

## 数据结构

下面是领域字段示意，实际实现必须从运行时 schema 推导类型。

```ts
type Support = 'supported' | 'unsupported' | 'unknown'

interface UsageScope {
  purpose: string // 用户可读的用途，不用于鉴权
  projectKey?: string // 工作区内登记的逻辑键，不是目录路径
  contextKeys: string[] // 已授权共享背景键，不能靠角色清单自行扩大
}

interface ConnectionGrant {
  schemaVersion: 1
  id: string
  revision: number
  workspaceId: string
  hostId: string // 首个实现为 codex-cli；桌面端单独标识
  pluginId: string
  hostSessionRef: string // 管理员配对；该凭据只关联一个会话
  characterIds: string[]
  allowedProjectKeys: string[] // [] 只允许不带 projectKey 的使用
  allowedContextKeys: string[]
  actions: Array<
    'discover' | 'bind' | 'context.read' | 'memory.search' | 'memory.propose'
  >
  isolation: 'strict' | 'relaxed'
  status: 'active' | 'revoked'
  createdAt: string
  expiresAt: string
  credentialDigest: string // 认证材料只在服务端，不返回给模型
}

interface Binding {
  schemaVersion: 1
  id: string
  revision: number
  workspaceId: string
  connectionId: string
  grantRevision: number
  serviceGeneration: string
  hostSessionRef: string
  character: { id: string; version: string; digest: string }
  scope: UsageScope
  actions: ConnectionGrant['actions']
  evidenceId: string
  isolationEffective: 'strict' | 'relaxed'
  status: 'active' | 'closed' | 'revoked' | 'expired' | 'interrupted'
  createdAt: string
  expiresAt: string
}
```

每个绑定只含一个角色。持久角色经历的归属是 workspaceId + characterId，临时用途与权限归属 Binding。两个窗口即使同目录也需不同 hostSessionRef；不能按 CWD、客户端名称或 PID 生成可复用的会话身份。

hostSessionRef 来自可信插件的会话关联或用户明确的当前会话配对；服务为真实网关连接分配独立身份，不能由模型任意报一个字符串冒领别的绑定。同宿主会话只允许一个活动角色；新角色默认要求新会话。绑定上限为 60 分钟，证据或授权先到期则先失效；首版不自动续期，不允许跨宿主会话恢复旧绑定。

```ts
interface HostEvidence {
  schemaVersion: 1
  id: string
  connectionId: string
  hostSessionRef: string
  hostId: string
  hostVersion: string
  pluginVersion: string
  verifierVersion: string
  hostBinaryDigest?: string
  configurationDigest: string
  globalMemoryRead: 'disabled' | 'enabled' | 'unknown'
  globalMemoryWrite: 'disabled' | 'enabled' | 'unknown'
  contextInjection: 'tool-result' | 'native' | 'unsupported' | 'unknown'
  contextRemoval: Support
  fileBoundary: 'enforced' | 'host-controlled' | 'unknown'
  providerRetention: 'configured' | 'unknown'
  result: 'pass' | 'fail' | 'unverified'
  checkedAt: string
  validUntil: string
}
```

证据由可信本地验证器提交至管理面，模型不能通过 agent RPC 上传 pass。单靠宿主自报版本、模型回答、MCP clientInfo 或安装声明均不能生成可信证据。匹配连接、会话、插件、二进制/配置及检查版本，证据期限不超过 60 分钟；环境变化需立即重新验证，不能只等 TTL。

strict 要求读写两项 disabled、有效 pass 及明确的会话注入方式，且记录宿主文件权限边界。fileBoundary=host-controlled 不等于阻断任意本机文件访问；strict 只命名“经验证的宿主自动记忆策略”，不能显示成完整系统沙箱。

可信验证器按宿主、按版本分别实现和认证；某个宿主版本的认证结论不外推到其他宿主或版本，结果记录在[实现状态](status.md#宿主隔离认证)。没有认证的宿主默认拒绝 strict 绑定（ISOLATION_UNSUPPORTED）。

relaxed 只能由管理端在 ConnectionGrant 上显式设置（isolation=relaxed），绑定的 isolationEffective 随之为 relaxed；agent、插件和模型参数都不能选择或降级。用户可以在未认证宿主上用 relaxed 加载真实角色与私人记忆，这是知情的风险选择，不构成 strict 证据。当前授权只记录隔离级别；按宿主能力档案结构化记录缺项属于后续工作，见路线图 R3。

## RPC 封装与工具映射

网关连接后首先通过已鉴权的 `service.describe` 获取支持的领域协议版本、服务世代、操作集与字节上限；无共同版本时拒绝继续，不按插件版本号猜兼容。这个传输握手不是第七个 agent 工具，不返回角色正文。服务与网关可使用同一主版本不同插件版本，实际以协商结果为准。

宿主插件的最小描述如下；插件声明只说明如何接入，不能替代 HostEvidence：

```ts
interface HostPluginDescriptor {
  pluginId: string
  pluginVersion: string
  hostId: string
  protocolVersions: number[]
  contextMode: 'tool-result' | 'native'
  sessionAssociation: 'native' | 'explicit-pairing' | 'unsupported'
  lifecycle: Array<'load' | 'close' | 'before-compact'>
  verifierVersion: string
}
```

每个插件实现包描述/配置生成、会话配对、能力检查、上下文呈现和退出提示五个接点。领域操作和持久数据只在 Core/协议包实现。生命周期列表只写已经验证可接入的事件；基础 Codex 插件不要求 before-compact，不能因声明了 close 就假设强制退出会通知服务。

```ts
interface ProtocolRequest {
  protocolVersion: 1
  requestId: string // UUID；每个调用都带，变更操作持久去重
  operation: string
  params: Record<string, unknown>
}
```

认证来自传输，不在 params；服务派生 caller，忽略/拒绝模型伪造的 workspaceId、actor 和凭证字段。MCP 工具名用下划线，统一操作名用点；SDK 协议协商与这里的领域版本独立。

| 统一操作 / MCP 工具               | 输入                        | 返回与限制                                                 |
| --------------------------------- | --------------------------- | ---------------------------------------------------------- |
| characters.list / characters_list | 无                          | 授权角色的 id/name/version；不含设定、关系、记忆或私人摘要 |
| bindings.open / bindings_open     | characterId、scope          | 当前已配对会话的绑定；strict 能力不足时失败                |
| context.get / context_get         | bindingId                   | 有界的实际角色文本、已确认记忆、策略提示和交付清单         |
| memory.search / memory_search     | bindingId、query、limit     | 授权范围内的已确认记忆及来源，含本次交付 ID                |
| memory.propose / memory_propose   | bindingId、candidate        | 返回候选 id/revision/status，不修改已生效记忆              |
| bindings.close / bindings_close   | bindingId、expectedRevision | 关闭本人绑定，幂等；不取消宿主任务、不清除聊天             |

读取角色内容之前必须 open；characters.list 不需要通过记忆隔离检查，但仍须有 discover 授权。绑定 ID 不作为 bearer token，每次请求核对调用方、配对会话、服务世代、授权 revision、状态、到期及证据。记忆/快照下载同样校验，不能绕过已撤销绑定。

scope 必须是授权范围子集，必填项缺失不能回退默认角色/项目；客户端不能用用途字符串获得权限。用户授权变更使旧绑定失效，需重新 open。撤销与进行中请求在提交/返回敏感内容前串行检查；撤销已确认后不再提交或释放新结果，已交付内容无法追回。

绑定创建、候选提交、关闭和管理决定使用工作区现有 requestId 回执体系。指纹包含调用方、操作、绑定、规范参数；同 ID 不同内容为 CONFLICT。变更回执与数据同事务提交，网络断开后重试返回原结果；重试前仍须通过当前鉴权，不得返回已撤销权限下的私人正文。只读响应不强制永久保存整份结果。

角色启停的宿主动作只作用于绑定线程，禁止调用全局 config/write、plugin/uninstall、config/mcpServer/reload 或修改项目插件开关。关闭先使服务端绑定失效，再撤下该线程的角色工具；无法完成线程级操作时保持拒绝访问并说明限制。已交付历史不被抹去，当前线程不恢复全局记忆生成，其他线程不受影响。

packages/protocol 的 hostSessionAssessmentSchema/strictActivationDecision 是传输侧准入基础，拒绝 lab-probe、self-report、会话不匹配、未关闭读/生成、共享配置写入和跨会话影响。它们不发行可信证据：后续服务必须从受信注册表解析来源，并在授权与绑定检查之后使用，不能因为传入 source=trusted-host-session 就授予权限。

## 上下文交付

```ts
interface ContextDelivery {
  schemaVersion: 1
  id: string
  bindingId: string
  characterDigest: string
  policyDigest: string
  createdAt: string
  entries: Array<{
    ref: string // 服务生成的稳定引用，无任意文件路径
    kind: 'persona' | 'voice' | 'relationship' | 'mode' | 'context' | 'memory'
    revision?: number
    digest: string
    utf8Bytes: number
    reason: string
    text: string
  }>
  excluded: Array<{ ref: string; reason: string }>
  contentDigest: string
  totalUtf8Bytes: number
}
```

context.get 和 memory.search 都生成交付清单及访问记录；清单包含实际返回内容的摘要，不只返回“已激活”。它证明服务端返回内容，不是完整宿主 prompt。存储快照沿用 P2 事务与大小/路径校验，不能把此类型硬写到旧 Run 的 context.json。

先按角色、工作区、projectKey 和 contextKeys 过滤，才执行关键词/标签选择。首版不用向量服务，排序确定且可解释；不读取其他宿主聊天或旧执行切片消息。记忆只接受 confirmed 且未被替代、未撤回的当前版本。旧快照仅供管理审计，不作为新记忆检索来源。

初始交付正文预算 48,000 UTF-8 字节，最多 32 条记忆；query 最长 512 字符、limit 最大 20。必需角色设定超限返回 CONTEXT_LIMIT，可选条目按确定顺序排除并记录，不静默截断事实。RPC 请求和响应封装各上限 256 KiB；原文输出需计入 MCP 宿主工具预算，宿主截断能力需验收。

角色设定和记忆分区返回；记忆正文作为不可信事实材料，不能覆盖宿主系统规则、工具授权或用户指令。授权共享背景来自显式选择，不从角色包 contextKeys 自动授予。

memory.search 已实现的响应为 `{ delivery: ContextDelivery, matches: Array<{ id, revision, kind, content, tags, score, reason }> }`，不返回来源摘录和其他宿主 session 标识。context.get 接受可选 mode（conversation / coauthor）。详见[记忆闭环](memory.md)。

## 候选记忆与审核

新的宿主来源不是旧 messageRef。M1 已增加独立 Memory v2 schema，提供显式迁移与原字节备份，增加 workspaceId、scope 及如下来源；保留 v1 schema 供兼容校验，M3 已提供候选和审核业务：

```ts
interface HostExcerptSource {
  type: 'host-excerpt'
  connectionId: string
  bindingId: string
  hostSessionRef: string
  hostMessageRef?: string
  excerptRef: string // 工作区内部不可变摘录，不是宿主文件路径
  digest: string
  capturedAt: string
  suppliedBy: 'host-plugin' // 表明服务未独立核验聊天原文
}

interface CandidateInput {
  kind: 'fact' | 'event' | 'opinion' | 'relationship' | 'preference'
  content: string
  tags: string[]
  scope: { projectKey?: string }
  excerpt: string
  hostMessageRef?: string
  replaces?: string
}
```

candidate 不接受 actor、status、characterId、workspaceId、原文路径和源摘要；归属、摘要、时间与来源引用由服务生成。scope 必须在本绑定内；最多 4 KiB 记忆正文、8 KiB 摘录、16 个标签。仅接受用户明确要求保留或审阅的内容，不默认自动抽取或上传整个会话。

无 projectKey 的记忆是当前角色的工作区通用记忆；有 projectKey 的只在相同项目绑定中检索。确认记录仍默认 private，不允许通过 publishable 绕过接入权限。首版不跨角色共享记忆；共享资料走用户单独批准的 contextKey。

状态：candidate → confirmed / rejected，confirmed → retracted；确认替代项时同事务把旧项改为 superseded。confirm/reject/retract 已实现在管理面，均要求用户身份、expectedRevision 和 requestId；MCP 工具表不暴露这些操作，模型自称 user 无效。

检索只读，不能提升候选。模型归纳、用户确认、内容安全检查与事实分类分别记录，不以“已确认”等同事实为真。只有提供了可核查来源且用户审阅后才把推断分类为 fact；缺依据时应标 opinion。更正/撤回不删除历史交付，隐私彻底删除需后续单独设计。

fact 确认还需要人工 factBasis，保存可选 factReview；服务不把这个依据当作外部事实已被自动核查。替代确认需要旧项 expectedRevision。

审核成功后新查询看见新状态，旧宿主上下文不会被服务后台改写。其他绑定不能读取候选；管理端可查来源。绑定到期/关闭不会丢弃已经保存的候选，用户仍可审核。

## 管理操作与拟议 CLI

service、connection、binding 管理命令已在 M2 实现，完整用法见 [service.md](service.md)。plugin 命令仍为计划；M3 的 context / memory 命令已实现，见 memory.md；其余拟议命令，不应作为当前 CLI 示例：

| 命令                                                                                                       | 语义                                                       |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| service serve --workspace PATH                                                                             | 前台启动一个工作区的管理服务；无需模型认证                 |
| service status / stop --workspace PATH                                                                     | 鉴权查询/请求优雅停机；不杀任意进程                        |
| connection grant --host codex-cli --plugin characters --host-session REF --character koto --workspace PATH | 用户登记会话及范围并安全生成凭证引用；默认 strict          |
| connection list / revoke ID --expect-revision N --workspace PATH                                           | 查看或按版本撤销授权，同时使所属绑定失效                   |
| plugin codex prepare --output PATH --workspace PATH                                                        | 在显式目录生成通用接入包与配置模板，不修改宿主全局文件     |
| plugin codex doctor --connection ID --workspace PATH                                                       | 检查插件/宿主与当前已配对会话的证据；无法检查则 unverified |
| binding list / show ID / revoke ID --expect-revision N --workspace PATH                                    | 管理端检查归属、证据与状态；撤销需要版本                   |
| context explain SNAPSHOT_ID --workspace PATH                                                               | 默认只显示清单；完整内容需用户显式查看                     |
| memory list / show ID --workspace PATH                                                                     | 用户管理角色记忆与来源；列表可用 --character 过滤          |
| memory confirm / reject / retract ID --expect-revision N --request-id UUID --workspace PATH                | 用户审核，原子写入决定与访问记录                           |

用户管理 CLI 认证管理面；agent 网关不提供管理 token。服务在线时管理请求走同一 Core 规则，服务离线时存储维护保留 P2 的锁与恢复行为；不在请求失败后暗中做第二次离线写入。

## 错误、恢复与兼容

保留已有结果封装和错误码。M1 已加入 PROTOCOL_UNSUPPORTED、SERVICE_UNAVAILABLE、BINDING_INACTIVE、EVIDENCE_EXPIRED 及对应退出码。未鉴权/越权用 PERMISSION_DENIED，能力不足用 ISOLATION_UNSUPPORTED，版本/去重冲突用 CONFLICT，数据损坏用 STORE_CORRUPT/RECOVERY_REQUIRED。

新增 CLI 退出码：协议/服务失败为 6，绑定失效/证据失效为 5；已有退出码保持不变。临时网络失败可按同 requestId 重试；权限、失效绑定和协议错误不能通过静默降级重试。

服务重启先恢复已准备事务，再把旧世代活动绑定设为 interrupted；保留候选、交付与审核记录。新宿主会话必须重新验证和绑定。停止服务不是停止宿主 agent，也不表示角色内容已被宿主遗忘。

新服务配置保存为独立的 service.yaml（schemaVersion: 1），接入策略包含 strict 默认、绑定期限和预算；不把字段追加到目前 strict 校验的 workspace.yaml。旧 runtime.adapter/network/tools 字段只对早期执行器有效，不决定宿主工具权限。Memory schema 扩展需升版、显式迁移命令、备份和失败恢复；旧原文/ID不重写，公开角色包格式保持 v1。

新增路径必须纳入 P2 存储允许列表；描述符和凭证是受保护运行数据，不进入通用内容对象、可分享角色包或插件包。读写记录、审核和回执原子提交；单文件 rename 不替代多对象事务。普通测试不访问真实模型和用户凭证。
