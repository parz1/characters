# Codex M0 接入验证

日期：2026-10-25。已完成 M0 的本地可行性调查与可重复实验，未安装到用户真实环境，未验收现有 Codex CLI TUI 或桌面会话的完整插件体验。M1 已开始传输契约部分，服务、网关和生产插件仍未实现。

## 结论与下一步

本机 Codex 的底层能力可以支持按线程选择插件、附加真实线程标识和独立控制记忆策略。但普通 MCP 工具/原生插件本身没有因此获得修改当前宿主会话策略的权限。我们仍需一个经验证的宿主生命周期接入点，不能用角色启停去安装/卸载全局插件或改写共享配置。

用户要求的“随角色启动/关闭可插拔，其他 session 不受影响”已作为硬性验收条件：

1. 角色启用只在明确选择的宿主线程生效，启用前先验证该线程的记忆读取与生成策略。
2. 角色关闭先撤销服务端 Binding，拒绝后续正文交付和写回，再按线程移除角色插件工具。
3. 全程不改全局/项目插件开关、不调用全局 MCP reload、不更改其他线程的记忆模式。
4. 已交付内容仍在宿主历史中；关闭后不重新允许这个线程参与全局记忆生成，否则旧角色历史仍可能被提取。其他线程原有策略保持不变。
5. 无法安全关联或控制当前线程时拒绝 strict 加载，不偷偷启动另一套聊天/agent，也不退回共享配置方案。

可以继续 M1 至 M4 的宿主无关实现；Codex 正式插件的 strict 就绪状态仍为 false。M0 发现的 App Server API 是实验依据，不能作为擅自接管用户现有 daemon 的授权，也不能把实验客户端变成产品聊天客户端。

## 实验方法与可重复命令

```powershell
pnpm build
pnpm codex:m0
# 可选：保存到一个尚不存在的文件；拒绝覆盖已有报告
pnpm codex:m0 --output .local/codex-m0/my-report.json
```

可用 --codex 指定二进制。脚本先在 OS 临时目录创建独立 CODEX_HOME、HOME、配置、数据库与本地插件目录，再运行单独 app-server。模型 provider 从进程启动起指向本机模拟 Responses 服务，不读取 auth.json、不使用真实模型或 API 凭证、不连接现有真实 daemon。

native plugin 的安装只发生在这个假 HOME 中；安装完成后共享配置预置插件 disabled，再开始生命周期实验，实验期间不改共享配置。模型响应由测试服务确定性构造，触发真正的 Codex MCP 调用并捕获下一轮模型请求。所有角色与记忆内容都是固定的测试标记，不包含 Koto 私有经历或真实用户会话。

同一 app-server、同一工作目录并行保留三个线程：

- A：启用实验插件，显式关闭记忆读取与生成，并设置 disabled memory mode。
- B：不使用角色，保留正常记忆读取与 enabled memory mode；在 A 启停前后分别执行。
- C：另一活动插件线程，只设 disabled memory mode，保留记忆读取，作为负对照。

检查内容包括实际 MCP `_meta`、模型输入和工具表、实验 state_5.sqlite 的 memory_mode、共享配置字节与记忆标记文件；不读取用户真实数据库。数据库只读查询是实验观测，不作为将来生产插件直接操作 Codex 私有数据库的接口。

## 固定宿主与证据

- 版本：codex-cli 0.164.0-alpha.11.1。
- 二进制 SHA-256：`1103e9e09c71fa2cd0afd6d8f3b9a2d63174fe8efd7cb5bd09f1cb14ef58a098`。
- 结构化结果：[本次报告](evidence/codex-m0-2026-10-25.json)。
- 实现：scripts/lib/codex-m0-probe.ts、scripts/lib/codex-rpc.ts。
- 回归：tests/codex-m0.test.ts、tests/fixtures/codex-m0-mcp.mjs。

| 项目                                      | 实测结果               | 解释与边界                                                                                     |
| ----------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------- |
| `.codex-plugin/plugin.json` + `.mcp.json` | 通过                   | 本地目录市场发现、临时安装、MCP 工具实际加载                                                   |
| 仅 root plugin.json + mcp.json            | 此版本未识别为完整插件 | 官方较新 portable 形式不能直接推定本机可用；首个具体目标使用兼容形式                           |
| thread/start 配置选择插件                 | 通过                   | 仅 A/C 启用，B 和新建未启用线程没有该工具                                                      |
| MCP 工具调用线程关联                      | 通过                   | 真实模型工具调用的 `_meta.threadId`、sessionId、turn metadata 与目标线程匹配；工具参数是空对象 |
| 角色工具结果进入上下文                    | 通过                   | 后续实际请求 input 含角色标记，B 的 input 不含                                                 |
| 关闭 A 的记忆读取                         | 通过                   | A 的实际请求不含全局记忆标记，B 在前后两次请求仍含该标记                                       |
| 关闭 A 的生成资格                         | 通过，范围有限         | 实验数据库中 A/C 为 disabled，B 为 enabled；不是生产后台长期提取全链路验收                     |
| 仅设置 memoryMode=disabled                | 不足以阻止读取         | C 仍加载记忆；生成资格与读取开关必须分开验证                                                   |
| 按线程 disabledPluginIds 停用             | 运行时通过             | A 后续模型工具表移除插件，直接 mcpServer/tool/call 也被拒绝；C 保持启用                        |
| 按线程重新启用                            | 通过                   | A 清空禁用列表后工具恢复，B 仍不含插件                                                         |
| 修改其他会话/共享配置                     | 未观察到               | B 的工具表与记忆读取保持原样，生命周期期间假 HOME config.toml 字节不变                         |
| 关闭后角色历史消失                        | 不支持                 | A 的后续请求仍包含已交付的角色工具输出                                                         |
| 直接用于已打开的 TUI/桌面                 | 未验证                 | 实验使用可控 App Server 客户端，不证明普通插件拥有对应控制入口                                 |

本机生成 schema 对 disabledPluginIds 仍写着“Does not yet filter plugin capabilities”，但真实请求和直接工具调用已经表现为过滤。报告同时保留 schema 说明与运行时结果；判断不能只看字段名、注释或成功响应。

MCP 元数据提供会话关联，不能替代鉴权和策略证明。它只在已认证的可信宿主连接中使用，不能接收任意模型参数中的 threadId 当作证据。

## 对后续实现的约束

M1 的 agent 请求不接受 token、workspace 路径、actor、宿主证据或自行确认状态；输入校验复用 Core 类型。strict 准入检查分别要求当前会话可信证据、读/生成已禁用、工具控制按线程、无共享配置写入、无跨会话影响。实验报告及模型自报不能被当成真实会话证据。

M2 服务端负责撤销和拒绝旧绑定，M4 网关保留宿主的可信线程元数据并匹配授权；不能只把 threadId 填进普通工具参数。M5 需要补足普通 Codex 接入包能否安全取得当前线程控制的证据，不能调用 config/write、plugin/uninstall 或 config/mcpServer/reload 来“模拟热拔插”。

工具动态移除不等于删除历史上下文。关闭后的当前线程不恢复全局记忆生成；若用户要求完全退出角色，则新会话。宿主文件工具权限与提供商保留仍是另外的边界。

## 尚未完成

- 已安装普通插件在原生 CLI/桌面里的会话控制入口与生命周期回调。
- 生产验证器的可信证据签发、过期与环境变化检测。
- 强制退出、会话恢复、fork、上下文压缩和原生工具输出预算的完整矩阵。
- 带真实用户授权的模型对话与长期后台记忆生成验收。
- 管理服务、持久绑定、记忆状态机、迁移和生产 MCP 网关。

探索阶段还观察到：默认 provider 的 App Server 可能预热外部连接，因此可重复脚本从启动参数起即固定本地 provider。早期一次仅调查安装的试验遇到无凭证的外部 401；没有模型结果或私人输入。该探索不作为隔离证据，保存的报告只来自后续全程本地模拟的正式脚本。首轮 Windows 清理遇到 EBUSY 后已加入有界重试，清理失败会令整个探测失败，不返回 cleanup=true。

官方文档只作为机制参考，具体结论来自上述本机实验：

- [插件打包与项目启用范围](https://developers.openai.com/plugins/build/plugins)
- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [本地记忆与会话控制](https://learn.chatgpt.com/docs/customization/memories)
- [配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)
