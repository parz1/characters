# M3：上下文与记忆闭环

M3 已实现本地 HTTP 服务中的 context.get、memory.search、memory.propose，以及管理 CLI 的审核、共享背景和交付解释。它不启动模型，不自动读取宿主聊天，不修改 Codex 全局配置。MCP 网关和原生宿主插件仍在 M4 / M5。

## 直接运行演示

在任意终端执行，workspace 必须是新的空目录：

```powershell
pnpm --dir D:/projects/characters demo:m3 --workspace D:/projects/characters/.local/my-m3-demo
```

这个演示使用合成偏好和来源摘录，自建临时服务，以管理身份确认样例，验证以下流程：

1. 加载 Koto 的人格、口吻、关系和 conversation 模式。
2. 提交候选，检索仍为空。
3. 管理身份确认；新的 session 绑定能够查到它。
4. 撤回记忆；新查询不再命中。
5. 停止演示服务，保留工作区记录供检查。

输出明确标记 isolation=relaxed、hostIsolationVerified=false。它没有连接 Codex，也不代表宿主隔离验证成功；再次使用同一路径会拒绝覆盖。不要在个人真实记忆工作区运行合成演示。

## 人工审核

日常使用默认程序目录 `.local/data`，以下命令中的 --workspace PATH 可省略；演示仍要求显式新的空目录，防止合成数据污染默认记忆。以下命令需要管理服务已启动。把 MEMORY_ID / SNAPSHOT_ID / BINDING_ID 替换为实际返回的 ID：

```powershell
pnpm characters memory list --character koto --status candidate --workspace PATH --json
pnpm characters memory show MEMORY_ID --character koto --workspace PATH --json
pnpm characters memory confirm MEMORY_ID --character koto --expect-revision 1 --workspace PATH --json
pnpm characters memory reject MEMORY_ID --character koto --expect-revision 1 --reason "不保留" --workspace PATH --json
pnpm characters memory retract MEMORY_ID --character koto --expect-revision 2 --reason "不再适用" --workspace PATH --json
```

list 默认返回最多 50 条元数据，支持 --limit（最多 100）、--after（上页 nextCursor）。show 才返回正文、状态、决定和必要来源摘录。来源明确标 suppliedBy=host-plugin，服务只能核对保存后的摘要和归属，不能独立证明摘录来自真实宿主聊天。

confirm / reject 只接受 candidate；retract 只接受 confirmed。所有操作要求 expectedRevision，支持 --request-id UUID 安全重试；同一请求 ID 修改参数会冲突。agent 工具没有这些管理动作，候选、模型输出或记忆检索不会自动升级状态。

确认 fact 还需要 --fact-basis TEXT，记录用户核查了哪些来源。这个人工依据不等同服务已验证事实为真。缺乏依据时应提交 opinion，而非把模型推断当作 fact。损坏的来源不能确认；拒绝或撤回不要求来源仍可读取。

候选可提出 replaces。确认时需同时提供 --replace-expect-revision N；新项 confirmed 与旧项 superseded、双方决定、审计和回执同一个 WAL 提交。旧项已被修改、范围不同或属于其他角色时失败。不会隐式替代、覆盖正文或跨角色引用。

## 显式共享背景

```powershell
pnpm characters context import people/parz1 --file ./background.md --expect-revision 0 --workspace PATH --json
pnpm characters context revoke people/parz1 --expect-revision 1 --workspace PATH --json
```

新建用 revision 0，更新用当前 revision。最多导入 16 KiB UTF-8，复制为不可变对象并保存用户批准的版本记录。agent 不能导入背景，也不能提交任意宿主文件路径。角色包的 contextKeys 只是提示；绑定必须显式选择且连接授权允许该键，才会加载。被撤销的背景立即从新交付中排除。

背景与记忆是独立、显式批准的资料。撤销背景不会自动撤回相关记忆；撤回记忆也不会删除用户另行导入的文字。服务不会把旧快照、索引或共享背景自动重新导入为记忆。

## Agent 操作与隔离

context.get 参数为 bindingId 和可选 mode（conversation / coauthor）。返回 ContextDelivery，分区包含必需角色设定、明确授权的共享背景与最多 32 条有效记忆。memory.search 使用 bindingId、query、limit，返回 `{ delivery, matches }`：命中只含 id / revision / kind / content / tags / score / reason，不返回其他 session 的来源摘录、消息标识或授权凭据。

每次先过滤 workspace、角色、confirmed 状态、projectKey 和 contextKeys，再执行关键词 / 标签匹配。查询按空白分词、忽略大小写；每个词正文匹配计 1 分，标签匹配计 2 分，按总分降序、ID 升序稳定排序。这是确定性关键词检索，不是语义或向量搜索。

候选的 projectKey 必须与绑定一致；项目绑定不能省略它来扩大成通用记忆。无 projectKey 的通用记忆只能从无项目绑定提交，在相同角色的其他授权绑定中可见。contextKeys 从绑定复制，只有包含全部相关键的后续绑定可用。不同工作区、不同角色不共享记忆。

memory.propose 只接收必要正文（4 KiB）、摘录（8 KiB）、分类、标签、范围和可选替代项。服务生成归属、时间、摘要及来源引用，始终以 candidate / private 保存。需要 memory.propose 权限；加载和检索分别要求 context.read / memory.search。

每次访问及重试仍受连接、session、授权 revision、服务世代、绑定、期限和宿主证据约束。已审核候选的旧提交回执不能重放旧正文；读取操作不缓存整份结果，同 requestId 也重新计算当前状态，撤回后不会重放旧命中。关闭或撤销绑定后不能下载上下文或旧交付。

真实 Codex strict 仍缺生产宿主验证器，因此拒绝绑定，不会自动转 relaxed。当前 HTTP 测试客户端和演示不能替代 M4/M5 的可信配对。

## 交付清单与预算

```powershell
pnpm characters context explain SNAPSHOT_ID --binding BINDING_ID --workspace PATH --json
pnpm characters context explain SNAPSHOT_ID --binding BINDING_ID --content --workspace PATH --json
```

explain 是管理操作，默认输出脱敏清单；--content 才输出历史正文。清单核对绑定归属、角色摘要、各条 UTF-8 字节数与内容摘要。它证明服务返回过哪些内容，不证明宿主最终 prompt 未被截断。历史正文仅供管理审计，不作为新的记忆检索源。

交付文本上限 48,000 UTF-8 字节，service.yaml.contextBudgetBytes 可以进一步收紧。还检查整个 JSON 响应 256 KiB 上限。必需角色设定超限直接 CONTEXT_LIMIT，可选背景 / 记忆整条排除并记录原因；不截断事实。excluded 最多保留 128 条引用，避免清单自身无限膨胀。单角色扫描最多 4,096 条记录，超过时明确失败，不偷偷使用旧索引。

记忆正文是资料，不是宿主指令。服务不把它提升为系统规则、工具授权或全局人格。关闭不删除已经进入宿主的内容，也不恢复该线程的全局记忆生成。

## 存储与验证

记忆在 states/<character>/memories/<mem>.json，摘录在 bindings/<bind>/proposals/<mem>.txt，交付在 bindings/<bind>/deliveries/<snap>/delivery.json。共享背景在 contexts/<key>/context.json，正文对象按 SHA-256 不可变保存。现有 Memory v2 保持可读，factReview 是可选的人工核查记录。

写入与审核继续使用 P2 的 WAL、预期摘要、版本冲突和回执。tests/knowledge.test.ts 覆盖完整闭环、两个角色和项目隔离、背景撤销、权限拒绝、旧请求重试、来源损坏、预算、CLI，以及替代事务在第一处写入后进程退出的完整恢复。没有真实模型调用或宿主全局配置写入。
