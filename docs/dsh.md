# DeepSeek Harness 最小接入

日期：2026-10-27。已实现原生插件工具、按会话的 coauthor 上下文组装、管理端配对、空目录独立包生成和 SDK/合成 HTTP 回归。实际桌面版 0.2.1-rc.3 已完成用户手动操作的 Koto 写作与 relaxed 合成记忆闭环。默认 strict 的生产宿主验证仍未完成，不宣称目前已能安全接入私人记忆。

## 本机人工验收状态

- 桌面程序：`D:/apps/deepseek/DeepSeek Harness.exe`；配套 CLI：`D:/apps/deepseek/resources/runtime/cli/bin/dsh.cmd`。两者版本均核对为 `0.2.1-rc.3`。
- profile：`desktop`。已安装本机包 `.local/dsh-blog-20261027-rc3-01`，仅配置测试 workspace 与 blog 项目路径，无角色正文或密钥。用户重新启动后，两个独立原生会话均返回 `configured: true`。
- 独立测试 workspace：`D:/projects/characters/.local/validation/dsh-blog-20261027-01`。目录原先不存在，已初始化、显式迁移并安装 Koto；默认 `.local/data` 未改动。
- 用户已明确允许本次使用 relaxed 的合成实验。只给实际原生会话创建单独 relaxed grant，不改变 workspace 的默认 strict 策略，不读取默认记忆。
- 用户自行操作 Harness；维护代理只准备代码、服务、授权和管理端审核。先在 blog 新建会话，要求“只调用 characters_status，展示原始结果”，将结果提供给维护代理。预期 `configured: true`；否则先处理配置加载，不绕过检查。
- 配对后，宿主加载 Koto，以其自己的文件工具写测试草稿 `D:/projects/blog/.local/characters-validation/koto-draft-20261027.md`，不得发布。合成记忆使用唯一标记 `KOTO_BLOG_SYNTHETIC_20261027_01`，提交为候选，确认前检索不命中；管理端确认后，新原生会话独立授权配对并检索；管理端撤回后，再次工具检索应无命中。旧聊天仍保留内容，不能用模型的回忆回答代替工具结果。
- 初始诊断：原生 `characters_status` 返回真实会话 ID；旧配置下 `bindings_open` 返回 `PERMISSION_DENIED`。已核对该测试会话持久化日志中的 `tool/result`。

### 实际合成闭环结果（通过）

用户自行操作 Harness 并提供原始工具返回；维护代理通过管理端复核记忆记录、来源摘录、绑定和检索快照，直接读取草稿核对落盘。时间均为 UTC。公开文档中的会话、绑定、记忆和快照 ID 已替换为占位符；原始记录仅保留在本地。

| 步骤             | 实际证据                                                                                                                      | 结果 |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---- |
| 加载 Koto 并写作 | 会话 `SESSION_A`，绑定 `BINDING_A`；用户返回 persona/voice/relationships/coauthor 四项共 6019B；上述草稿文件已核对            | 通过 |
| 提交合成候选     | `MEMORY_A`，revision 1，candidate；来源绑定与会话匹配                                                                         | 通过 |
| 未确认不命中     | 12:06:18，`SNAPSHOT_BEFORE_CONFIRMATION`，entries 空、0B；用户原始返回 matches 空                                             | 通过 |
| 管理端确认       | 12:06:51，revision 2，confirmed；管理端独立审核，插件无确认操作                                                               | 通过 |
| 新会话命中       | 干净会话 `SESSION_B`，独立授权和绑定 `BINDING_B`；12:14:00 快照 `SNAPSHOT_AFTER_CONFIRMATION`，同一记忆 revision 2，154B      | 通过 |
| 管理端撤回       | 12:16:56，revision 3，retracted                                                                                               | 通过 |
| 撤回后不命中     | 12:17:22，原绑定仍在 12:18:57 到期之前；`SNAPSHOT_AFTER_RETRACTION` 查询成功、entries 空、0B；用户原始返回 matches 空，无错误 | 通过 |

本轮三个临时授权（含最初 strict 诊断授权）均已由管理端撤销至 revision 2；合成记忆保持 retracted，草稿和审计记录保留。没有发布文章，没有改动默认记忆。插件安装仍保留，其启停没有用于角色生命周期控制。

本次只验收实际工具/写作与合成记忆业务流程。`strictHostPolicyVerified` 一直为 false；完整模型输入预算、宿主全局记忆读取/生成、fork/恢复/压缩与生产验证器仍待独立验收。撤回阻止后续检索，不清除已交付的聊天历史。

## 已固定的接口依据

- 官方仓库：<https://github.com/deepseek-ai/deepseek-harness>，调查快照 `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`，源码位于忽略的 `.local/research/dsh-source-20261027`，只读参考。
- 实际编译/注册测试基线：npm `@deepseek-ai/dsh-*@0.2.1-rc.3`、`@deepseek-ai/cordis@4.0.5`。插件 0.1.0、characters 协议 v1。
- 使用原生 `exec.agent.id`，不是模型参数、clientInfo、CWD 或进程 PID 充当会话身份。
- 有效项目目录从 `ctx.workingDirectory.get(agent.session)` 读取；项目目录只增加范围检查，不代替会话身份。
- `system-prompt/assemble` 按实际 agent 筛选，然后向服务重新请求 `context.get(mode=coauthor)`，填入 required 动态上下文。完整系统提示词与关闭可选上下文不会静默丢弃角色；文章文件工具仍归宿主权限控制。

实现以实际安装的固定 SDK 类型为准。宿主升级后先核对版本，若不匹配应另做适配验证，不写兼容性豁免。

## 现在可以生成的诊断包

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm characters plugin dsh prepare --output D:/projects/characters/.local/dsh-diagnostics-NEW --json
pnpm characters plugin dsh doctor --json
```

输出目录必须不存在或为空。prepare 将内部依赖打包成一个原生 ESM 模块，保留宿主提供的 DSH SDK 导入，生成 package.json、cordis.patch.yml 和说明。输出无角色正文、私人记忆、凭据或工作区路径，不依赖 `workspace:*`；只读角色包仍在 characters 管理服务中。

prepare 不安装、不启动 dsh、不改用户全局/项目配置，也不写 blog。源插件目录的 workspace 依赖仅供本仓库开发，不直接作为外部安装目录；安装生成的独立包。

匹配版本的 CLI 安装示例（用户安装后手动执行；桌面 profile 名称和 UI 操作须以实际版本为准）：

```powershell
dsh plugin --profile web add D:/projects/characters/.local/dsh-diagnostics-NEW
```

这是一份通用安装包，首次只用于诊断。在 blog 项目的原生会话中要求调用 `characters_status`，它返回当前实际 session ID；不交付角色，不证明记忆隔离。其他操作在没有管理端配对时拒绝。

## 明确管理端配对

服务须已运行，角色 Koto 已安装，旧工作区迁移仍显式执行。使用 status 返回的真实 session ID：

```powershell
pnpm characters connection grant --workspace EXPLICIT_TEST_WORKSPACE --host dsh --plugin characters-dsh --host-session ACTUAL_SESSION_ID --character koto --project blog --action discover --action bind --action context.read --action memory.search --action memory.propose --ttl 3600 --json
pnpm characters gateway pair --workspace EXPLICIT_TEST_WORKSPACE --connection ACTUAL_CONNECTION_ID --host-session ACTUAL_SESSION_ID --json
```

读取真实结构化输出的 grant.id 与 pairingRef，不能复制示例字符串冒充配对。默认 strict；如果没有可信服务端 dsh 验证器，bindings_open 返回 ISOLATION_UNSUPPORTED，这是预期的拒绝。

只有管理端明确选择 `--isolation relaxed` 的合成实验才能在验证缺失时读取合成数据，不能由插件/模型自行降级。当前真实用户私有角色/记忆接入的 strict 验证缺口必须解决后再验收。

准备绑定本机配置的独立包：

```powershell
pnpm characters plugin dsh prepare --output D:/projects/characters/.local/dsh-blog-NEW --workspace EXPLICIT_TEST_WORKSPACE --project-root D:/projects/blog --project blog --json
```

配置包含本机显式路径，不适合分发；仍不含 token、角色或记忆。安装/配置更新是用户管理操作，需要按实际 dsh 版本应用配置并确认生效；prepare 不自动升级或覆盖已安装包。

省略 `--pairing` 时，插件只在指定 workspace 的受保护服务目录中查找当前原生会话唯一的管理端配对，不读取管理员令牌、不自行授权。新会话只需新 grant 和 pair，无需重装插件或修改共享宿主配置。也可用 `--pairing REF` 固定单一会话；多项匹配、未配对、项目不匹配均拒绝。角色状态按原生会话分开保存。

## 插件内使用路径

向已配对的原生会话明确提出“加载 Koto，协助我写这篇文章”。插件提供 characters_list、bindings_open、context_get、memory_search、memory_propose、bindings_close，以及诊断 characters_status。工具参数与通用协议相同：`requestId` UUID 和严格的 `params`。打开绑定需要 `scope.projectKey=blog`、`contextKeys=[]` 和明确用途。绑定 ID 来自实际服务结果。

只有匹配的 agent 进入角色上下文；其他 agent 的提示词不增加角色内容。每次提示词组装都刷新授权上下文，关闭、撤销、过期、服务断线或世代变化后拒绝新交付，不离线读取副本。model 自填 actor、token、路径、其他 binding/session、项目或管理操作均被拒绝。

记忆候选仍由宿主提交必要摘录，服务分配来源；管理端审核。模型没有 memory.confirm、memory.retract、connection.grant 等工具。插件自身不批准写文章、修改文件或发布；这些是宿主既有文件权限与用户请求决定的。

关闭绑定不会删除聊天。关闭后本线程不再加载角色；需要切换或重新加载时新建干净 dsh 会话并重新授权。已成功使用的配对有受保护运行占用记录，重载插件不能恢复激活；不自动删除占用或猜测旧会话是否还活着。正常 agent 销毁/插件清理尽力 close，强制退出依赖期限或管理撤销。不能用全局/项目插件开关、卸载、全局 MCP reload 代替角色关闭，也不能为含角色历史线程重新启用记忆生成。

## 当前验证结果与剩余项

无模型测试覆盖：固定真实 SDK 中加载插件并注册七工具、未配置不注入角色；原生会话/项目/绑定错配拒绝、未知字段与管理越权拒绝、并发打开只成功一次、关闭拒绝重开；真实本地 HTTP 的合成候选确认/新绑定检索/撤回；配对重载不复活；独立包构建与非空目录拒绝；原生会话配对查找与 required 上下文在完整系统提示词/可选上下文关闭时仍生效，角色关闭后不再贡献内容。默认 strict 缺少验证器始终拒绝。正常测试没有访问真实模型凭证。

实际安装的 dsh 仍需验证：当前版本与桌面/Web profile、工具调度传递的会话身份、真实模型输入中的完整 Koto 内容和预算、全局记忆读取/生成、第三方插件/后台任务、fork/恢复/压缩，以及配置变化后的证据失效。原生 SDK 注册和合成服务流程不代替这些证据。当前 `plugin dsh doctor` 是缺项报告，不是实时宿主 attestation。
