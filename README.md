# characters

characters 是本地、可插拔的角色与记忆管理系统。管理服务保存身份与经历，Codex、dsh 等宿主通过插件按需加载角色；对话、模型与任务执行留在宿主。

角色包可以分享，私人记忆按工作区和角色隔离。第一个角色是 Koto chan，写作、开发讨论和资料整理都是她可以参与的场景。

## 当前状态

基础设施阶段（管理服务、统一协议、记忆审核与检索、MCP 网关）已完成。当前目标是让 Koto 能被真实、持续地使用：下一步是路线图 R1 Koto 体验基线。Codex 插件暂缓，dsh 插件 strict 未认证。

各组件的实现状态与宿主隔离认证结果只在[实现状态](docs/status.md)维护，目标与里程碑见[路线图](docs/roadmap.md)。本文中的未来能力不是当前命令。

## 默认数据位置

数据先保存在 characters 项目根目录的 `.local/data`，不要求用户另选文件夹，也不需要每次传 --workspace。角色定义继续位于仓库的 characters/koto；多个角色共用一个服务数据目录。CLI 按程序位置定位，与当前终端所在目录无关。

首次执行 `pnpm characters workspace init`、`pnpm characters workspace migrate --target service-v1` 后，可以直接 `pnpm characters service serve` / `service status`。初始化不覆盖已有数据；迁移仍需明确执行。下面带 --workspace 的示例仅展示自定义位置。

## 本地开始

想直接测试角色表达，在安装依赖并构建后运行 **`pnpm characters chat kurisu`**。未配置 DeepSeek key 时会隐藏输入提示，无需 PowerShell 变量或 Codex。`/remember 内容` 只提交候选，审核仍在管理端；`/new` 开始干净会话，`/exit` 退出。新目录自动初始化，已有角色不覆盖、旧工作区不自动迁移。该薄客户端用于测试服务和路线图 R2 的真实相处试用，不改变 characters 的产品定位。详见[参考客户端指南](docs/reference-host.md)。

需要 Node.js 24.18 或更新版本，pnpm 使用 package.json 固定版本。在项目根目录执行：

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm characters --help

pnpm characters workspace init D:/characters-data/personal --json
pnpm characters character add ./characters/koto --workspace D:/characters-data/personal --json
pnpm characters character list --workspace D:/characters-data/personal --json
pnpm characters workspace status --workspace D:/characters-data/personal --json
```

初始化拒绝覆盖非空目录。安装复制角色文件并锁定摘要；不同内容不能隐式替换相同 ID。CLI 默认使用程序根目录的 .local/data，支持 --workspace 显式覆盖；Core / 服务仍接收明确的 WorkspaceHandle，不扫描 HOME 或把当前终端目录当成数据目录。

已提供 Codex 通用接入包模板与 MCP 网关，但现有真实会话的生产能力验证器尚未实现，strict 仍拒绝加载。已有独立执行方式见[早期 Codex 试用](docs/codex.md)，它保存自身会话与建议稿，使用每轮新进程；不代表新的宿主插件体验。

管理服务已可运行：

```powershell
pnpm characters workspace migrate --target service-v1 --workspace D:/characters-data/personal --json
pnpm characters service serve --workspace D:/characters-data/personal --json
```

在另一终端使用 service status / connection grant / binding list / service stop，详见[管理服务指南](docs/service.md)。默认 strict 仍会拒绝没有可信宿主证据的绑定；不会修改 Codex 全局配置。

M3 角色上下文、候选审核、检索和撤回已实现。运行合成样例：`pnpm demo:m3 --workspace NEW_EMPTY_PATH`，详见[记忆闭环指南](docs/memory.md)。演示明确使用 relaxed，不代表 Codex strict 已接入。

M4 同样的合成流程可经真实 MCP SDK 客户端运行：`pnpm demo:m4 --workspace NEW_EMPTY_PATH`。Codex 包准备：`pnpm characters plugin codex prepare --output NEW_EMPTY_PATH`；诊断：`pnpm characters plugin codex doctor --json`。均不改宿主配置或默认记忆，见[网关与接入指南](docs/mcp.md)。

## 目标使用方式

用户启动角色管理服务，在宿主安装一次通用 characters 插件。在 Codex 中明确要求加载 Koto，插件按授权取得设定和相关记忆；用户继续使用原生 Codex 交流。需要保留的决定提交为候选，管理端审核后才成为长期记忆。

管理 GUI 只管理角色库、记忆、接入授权与使用记录。它不提供主聊天界面。插件安装、角色启用和私有记忆授权是不同动作。

新主线的最小闭环是：服务启动 → 插件发现 → 验证宿主能力 → 绑定角色 → 读取上下文 → 在宿主交流 → 提交候选 → 管理 CLI 审核 → 新绑定检索 → 退出并拒绝后续访问。

## 文档入口

| 文档                                                   | 内容                                     |
| ------------------------------------------------------ | ---------------------------------------- |
| [系统设计](docs/design.md)                             | 定位、架构、管理服务、插件与隔离边界     |
| [统一契约](docs/contracts.md)                          | 绑定、能力、上下文、记忆、操作与管理命令 |
| [实现状态](docs/status.md)                             | 组件状态、宿主隔离认证与已知体验缺口     |
| [路线图](docs/roadmap.md)                              | 目标、R0–R5 里程碑与已确定事项           |
| [基础设施阶段记录](docs/phase-1.md)                    | M0–M6 历史范围、收口结果与验证矩阵       |
| [Koto 长期相处验收](docs/koto-long-term-acceptance.md) | 场景步骤、证据与评分、当前实现缺口       |
| [Codex 插件设计](docs/codex-plugin.md)                 | 接入包、原生使用、能力证据和最小闭环     |
| [存储与恢复](docs/storage.md)                          | 已实现事务、版本和故障保证               |
| [早期 Codex 试用](docs/codex.md)                       | 现有执行适配器的真实用法和限制           |
| [旧执行契约存档](docs/legacy-execution-contracts.md)   | 写作 Session / Run / worker 的历史设计   |

## 开发与约束

```powershell
pnpm check
pnpm schemas:generate
```

当前 31 份 schema 源为 packages/core/src/schemas.ts；packages/protocol 提供请求、响应和会话准入校验，packages/service 提供连接授权、持久绑定与恢复。定义结构不等于实现业务命令。新字段须显式扩展 schema、存储允许路径与迁移，不能修改旧配置来伪装接入完成。

- 服务不需要模型凭证，不启动 agent 推理循环。
- 角色包不包含私人经历、凭证或可执行插件。
- 每个使用绑定固定角色版本、用途与权限，禁止全局“当前角色”。
- 记忆搜索不自动批准候选，agent 不能代用户审核。
- 不把角色设定写入宿主全局记忆、全局人格或项目 AGENTS.md。
- 严格模式下，宿主能力未知就拒绝角色内容加载，不自动降级。
- 文件和访问授权由程序控制，宿主提示词不能替代隔离或鉴权。

文档版本：v0.3，更新日期：2026-11-05。
