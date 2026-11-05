# 早期 Codex 执行试用：讨论选题与建议稿

这是已经实现的“characters 启动 Codex 执行”纵向切片。2026-11-05 起冻结：保留兼容与回归，不再增加功能，路线图 R5 前评估是否移除。当前产品主线是管理服务与宿主插件；状态见[实现状态](status.md)，目标见[路线图](roadmap.md)。本文的 session 命令继续有效，但这里的证据不证明 Codex 宿主插件或桌面当前会话已隔离。

当前最小闭环使用独立 Codex CLI 进程。characters 保存人格、会话消息、上下文快照和建议稿，Codex 只处理本次输入并返回结构化结果。每轮都创建新进程；接续对话依靠工作区中的消息，不能依赖 Codex 的历史会话或全局记忆。

当前实现覆盖讨论选题、生成提纲或草稿、保存建议稿、明确应用，以及运行审计。长期角色记忆、自动摘要、跨进程强制停止和通用 stdio 执行适配器尚未实现。旧 P3 至 P6 已由 v0.2 里程碑取代；本试用不代表新的插件闭环已实现。

## 准备与首次使用

需要安装 Codex CLI，并已通过 ChatGPT 登录。当前只支持文件形式的 ChatGPT 登录记录；不使用 API key，不读取系统密钥库。若只有 keyring 登录或登录已过期，先通过普通 Codex CLI 完成相应登录配置。characters 不修改原登录记录。

在 characters 项目根目录执行。以下 PowerShell 变量仅用于保存本次工作区和返回的 ID：

```powershell
pnpm install --frozen-lockfile
pnpm build

$characterWorkspace = 'D:/writing/kotolog'
pnpm characters workspace init $characterWorkspace
pnpm characters character add ./characters/koto --workspace $characterWorkspace
pnpm characters adapter doctor --workspace $characterWorkspace

$article = pnpm --silent characters work create --title '让角色拥有可携带的人格' --author character:koto --lang cn --kind log --workspace $characterWorkspace --json | ConvertFrom-Json
$conversation = pnpm --silent characters session open --character koto --work $article.data.id --workspace $characterWorkspace --json | ConvertFrom-Json
$characterSession = $conversation.data.id

pnpm characters session send $characterSession --message '我想写角色仓库的设计，先和我讨论文章的主张。' --workspace $characterWorkspace
pnpm characters session send $characterSession --message '读者是想与虚拟作者长期合作的开发者。请先问我一个关键问题。' --workspace $characterWorkspace

$draft = pnpm --silent characters session send $characterSession --intent draft --message '根据我们刚才明确讨论的事实，写一篇中文开发记录建议稿，不编造经历。' --workspace $characterWorkspace --json | ConvertFrom-Json
pnpm characters work proposal list $article.data.id --workspace $characterWorkspace
pnpm characters session run $characterSession --run $draft.data.runId --workspace $characterWorkspace
```

工作区已经存在时跳过 init；初始化不会覆盖非空目录。PATH 无法找到 Codex 时，在 doctor 和 send 上使用 --codex 指定可执行文件。未指定 --model 时采用干净配置下 Codex 的默认模型，不继承原用户配置中的模型选择；需要固定模型时在 send 上显式指定 --model。

--message 适合短消息，长素材使用 --file 指向 UTF-8 文件，两者不能同时提供。intent 默认 discuss，此时只讨论；outline 和 draft 要求绑定作品，并分别生成完整提纲或草稿建议。用户提供的资料、角色包中的虚构样本与真实经历明确区分。

## 查看和应用建议稿

send 不修改作品正文。建议稿带有 origin.type=run、sessionId、runId、原作品版本和引用来源。先查看 proposal list，再根据最新 work show 的 revision 显式应用：

```powershell
pnpm characters work show $article.data.id --workspace $characterWorkspace
pnpm characters work apply $article.data.id --proposal $draft.data.proposalId --expect-revision 1 --workspace $characterWorkspace
```

上面的 1 仅适用于示例中没有其他作品修改的情况。如果生成期间作品发生变化，建议稿仍保存，但旧 baseRevision 会使 apply 返回 CONFLICT。系统不会自动覆盖新版本。

session close ID 结束会话，session resume ID 重新打开；都不直接调用模型。session list 查看可继续的会话，session show ID 查看已保存消息。下一轮 send 从工作区重新构建上下文，不恢复旧 Codex 线程。

## 隔离机制

每次执行在工作区 .runtime/codex-executions 下创建独立目录，重定向 CODEX_HOME、HOME、USERPROFILE、APPDATA、LOCALAPPDATA 和临时目录，SQLite 状态也指向临时空间。只导入必要的短期认证字段，不复制原 config.toml、AGENTS.md、插件、技能、历史或记忆，不复制可复用 refresh token。

临时认证目录在 POSIX 上限制为当前用户访问，在 Windows 上通过 ACL 仅授予当前用户与 SYSTEM 访问。执行结束先删除认证副本，再移除整个临时目录。正常失败、超时和 Ctrl+C 也执行清理。

调用固定包含 ephemeral、ignore-user-config、ignore-rules、strict-config 与 read-only sandbox，关闭 memories.use_memories、memories.generate_memories、记忆特性、命令执行、插件、应用、浏览器、子代理、代码运行与目标工具，并禁止读取项目说明。CODEX_HOME 内 AGENTS.md 的加载行为与项目文档开关不同，因此绝不能把原配置目录整体复制到临时目录。

经过本机验证的 CLI 仍会暴露 request_user_input；它不是文件工具。doctor 仅允许该工具出现在请求中，其他任何工具都会使检查失败。实际执行拒绝工具调用事件，模型须用普通 reply 向用户提问。

## 如何验证

doctor 不调用真实模型，不需要认证。它把当前 Codex 二进制连接到本机模拟 Responses 服务，捕获实际请求并检查：

- 临时 Codex 记忆目录中的随机标记没有进入发出的模型请求。
- 原始环境指向的诱饵 AGENTS.md 没有被加载。
- 没有文件、命令、浏览器、插件或其他执行工具暴露。
- 记忆标记未被修改，临时目录完整删除。

通过后保存二进制摘要、配置策略摘要、版本、验证时间和证据 ID。每次新 send 都重新检查；执行前再次核对二进制摘要，不把旧证据用于变更后的 CLI。

真实执行另外比较原 Codex 记忆路径的文件元数据，检查临时目录中没有新建记忆或会话持久文件，记录没有观察到工具调用，并在清理成功后才提交回复与建议稿。只查看原记忆的文件元数据，不读取其正文。元数据未变化是写入侧的辅助证据，不单独作为“从未读取”的证明；读取隔离依靠独立目录、禁用配置、请求捕获和工具关闭共同验证。

每个 Run 的 input.json 保存角色、素材和消息输入；context.json 保存所选来源、版本、哈希与选择理由；evidence.json 保存隔离证据；events.json、result.json 和 run.json 保存结果、审计与状态。session run 展示这些信息中的上下文清单、证据和结果，不输出认证信息。完整输入只能通过工作区文件显式查看。

使用的官方机制见 [Codex 命令参考](https://learn.chatgpt.com/docs/developer-commands?surface=cli)与[配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)。本机真实试用版本为 codex-cli 0.164.0-alpha.11.1；其他版本必须重新通过 doctor，不能按版本号推定兼容。

## 失败和重试

使用 --request-id UUID 可以安全重试同一消息；键在工作区共享。相同输入返回已保存结果，不再调用模型。已失败或已取消的请求保留原状态，新尝试使用新 ID。结果摘要、请求映射和工作区回执不一致时停止重试，不重新生成掩盖损坏。

输入超出预算会明确报错，当前不自动摘要或静默截断。正常取消保存用户消息但不保存半份建议稿，释放会话后可以继续。通过 Ctrl+C 取消当前前台命令；暂未提供另一个终端里的 session stop。

若强制结束宿主进程或机器崩溃，P2 会恢复已经准备的文件事务，但不会推断模型是否已经计费或重新执行未完成请求。会话可能保留 activeRunId，临时目录可能仍有短期凭证；需确认原进程及其子进程退出后检查，当前不会自动抢占。可以创建新会话关联原作品继续，不能以删除标记冒充恢复成功。

## 保证范围

这里验证的是合作式 Codex CLI 的本地记忆和配置命名空间隔离，不是对恶意二进制的操作系统级沙箱。HTTPS 请求仍交给所用服务处理，不承诺提供商零保留，也不把它等同于“不写本地全局记忆”。

另一进程同时修改原记忆目录可能使真实执行检查失败，结果不会自动采纳。认证过期时需要先在原 Codex 中重新登录；本适配器不把刷新后的认证写回原配置目录。
