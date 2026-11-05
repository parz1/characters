# 管理服务使用与边界（M1 / M2）

管理服务已经可以运行，负责连接授权、会话绑定、撤销、访问审计和生命周期。M3 上下文读取、记忆候选、审核、检索及撤回也已实现，见[记忆指南](memory.md)。MCP 网关和 Codex 原生插件留在 M4 / M5。

## 默认位置

CLI 默认使用 characters 程序根目录下的 `.local/data`，与终端 CWD 无关。日常命令可以省略 --workspace。首次初始化用 `pnpm characters workspace init`，然后 `pnpm characters workspace migrate --target service-v1`，再 `pnpm characters service serve`；如需安装 Koto，可在项目根目录执行 `pnpm characters character add ./characters/koto`。不自动迁移或扫描其他目录；显式 --workspace 仍支持测试和多实例。

## 启动（自定义数据目录）

以下命令在 characters 项目根目录执行。已有工作区可跳过初始化和角色安装；迁移需要显式执行，不会重写旧 workspace.yaml 或早期 Session / Run。

```powershell
pnpm build
pnpm characters workspace init D:/characters-data/personal --json
pnpm characters character add ./characters/koto --workspace D:/characters-data/personal --json
pnpm characters workspace migrate --target service-v1 --workspace D:/characters-data/personal --json
pnpm characters service serve --workspace D:/characters-data/personal --json
```

serve 是前台进程，输出描述符后持续运行。在另一个终端管理：

```powershell
pnpm characters service status --workspace D:/characters-data/personal --json
pnpm characters connection grant --host codex --plugin characters --host-session YOUR_THREAD_REF --character koto --project blog --context people/parz1 --workspace D:/characters-data/personal --json
pnpm characters connection list --workspace D:/characters-data/personal --json
pnpm characters binding list --workspace D:/characters-data/personal --json
pnpm characters binding show BINDING_ID --workspace D:/characters-data/personal --json
pnpm characters binding revoke BINDING_ID --expect-revision 1 --workspace D:/characters-data/personal --json
pnpm characters connection revoke CONNECTION_ID --expect-revision 1 --workspace D:/characters-data/personal --json
pnpm characters service stop --workspace D:/characters-data/personal --json
```

使用实际返回的 ID / revision。管理命令通过私有文件读取管理员凭据；stdout 只返回 agent 凭据文件的相对引用，不输出凭据正文或 digest。`--request-id UUID` 可重试同一操作，修改参数必须使用新的 ID。角色、project、context 和 action 允许重复指定选项以形成明确允许集合。默认 action 只有 discover、bind，没有隐式记忆权限。

一个 ConnectionGrant 固定一个 hostId / hostSessionRef。这个标识由管理员配对，不能作为可信宿主能力证据。不同 session 使用不同授权；禁止给模型一个跨会话“当前角色”。同一宿主 session 同时只能有一个有效绑定，即便申请来自不同连接授权。

默认严格模式尚不能在 Codex 或 dsh 等未认证宿主中激活角色：CLI 没有可信的生产宿主验证器，会返回 ISOLATION_UNSUPPORTED。没有把 M0 实验报告当成真实会话凭据；各宿主认证结果见[实现状态](status.md#宿主隔离认证)。管理者可对单个授权显式使用 `--isolation relaxed`，包括在未认证宿主上加载真实角色与私人记忆；这是知情的风险选择，结果始终标记 relaxed，不代表记忆隔离，agent 参数不能切换隔离级别。通过 HTTP 测试客户端验证绑定的例子在 tests/service.test.ts，不需要模型或 Codex 凭据。

## 运行协议

描述符位于显式工作区 `.runtime/service/descriptor.json`，只包含工作区、端口、PID、主机、协议版本、服务世代和管理员凭据文件引用。端口随机，只监听 IPv4 回环。`POST /v1/rpc` 必须提供 Bearer 凭据、准确的 Host、application/json；拒绝 Origin、未知字段和不支持的版本，无匿名探活与跨域开放。请求和响应上限均为 256 KiB，队列和连接各最多 64。

`service.describe` 是已鉴权的握手，不是 agent 工具。当前广告并实现全部六种领域操作：characters.list、bindings.open、bindings.close、context.get、memory.search、memory.propose。管理身份不能冒充 agent 绑定；agent 身份不能授权、撤销别人的连接或审核记忆。

新绑定固定角色 id / version / digest、用途范围、允许动作、授权 revision、宿主 session 和服务世代。期限取服务上限（最多一小时）、授权期限和证据期限中的最短值。每次受保护操作检查当前授权与证据；旧 requestId 不能绕过撤销、到期、关闭、世代变化或可信配置变化。到期记录在后续管理请求中落为 expired，过期检查不依赖后台定时器。

可信 HostVerifier 在服务器创建时注入，异步获取宿主证据，之后在事务内重新检查。它不是可由 HTTP 导入的 JSON。严格准入要求当前会话的插件控制、记忆读取禁用、记忆生成禁用，且不影响其他会话、不要求共享配置修改。M4/M5 仍需解决实际宿主控制连接和来源认证；M2 的测试替身不满足这项生产验收。

## 启停边界

- 关闭或撤销一个 binding，只撤销这个绑定的服务访问；其他 session 的绑定保持有效。
- 撤销 connection，使属于它的绑定失效；不会控制其他 connection。
- service stop 停止整个工作区服务，所有活动绑定中断；其他工作区服务不受影响。
- 重启会恢复 P2 已准备事务，并把旧世代 active 绑定标记 interrupted；不会自动激活角色或启动宿主。
- 关闭不删除已经进入宿主聊天的内容，也不恢复该线程的全局记忆生成。干净退出角色上下文需要新宿主会话。

实现没有 Codex 配置写入、插件全局开关、卸载、全局 MCP reload 或宿主进程控制入口。

## 凭据与文件边界

POSIX 私有运行目录使用 0700、秘密文件使用 0600；Windows 先替换私有目录 DACL，只授予当前用户和 SYSTEM，读取实际 ACL 验证成功才写入凭据。失败就停止启动。管理员 token 每次服务启动轮换；agent token 的 SHA-256 摘要保存在授权记录中，原文只在私有运行目录。旧管理员文件即便因崩溃残留，也不能认证到新世代服务。

这些措施区分其他 OS 用户和协议客户端，不能隔离具有相同 OS 用户文件权限的恶意宿主。fileBoundary 明确记录 host-controlled；生产插件还需要宿主自身文件工具边界。服务不会宣称提供商留存或宿主文件访问已经隔离。

成功变更、审计与去重回执同一个 WAL 提交；拒绝访问使用独立脱敏审计，不保存 token、正文、完整聊天或原始异常。服务 owner 锁复用 PID / 主机 / token 检查：只接管确认死亡的本地主机 owner，未知、存活或外地主机 owner 保守失败。status/stop 不依据描述符 PID 杀进程。不要手工删除不能证明安全的 owner 锁。

## 迁移与回滚

新增 service.yaml（JSON 格式，也是合法 YAML）、migrations/service-v1/manifest.json 和逐条不可变备份。已有 v1 Memory 原字节备份后升级为 v2，增加 workspaceId 与 legacy-import 范围，保留候选状态、来源和决定；不会自动确认记忆。升级、配置、清单和备份通过同一个有大小上限的 P2 WAL 提交，恢复继续完成已准备事务。

```powershell
pnpm characters workspace rollback --target service-v1 --workspace D:/characters-data/personal --json
```

必须先停止服务。回滚只允许没有任何 connection / binding、没有新建或修改/删除记忆的工作区，且备份摘要完整。恢复 Memory 的原始字节，保留备份和清单，把 service.yaml 标记禁用；重新 migrate 可以启用服务。已有服务数据时拒绝回滚，需使用完整工作区备份。超出单个 P2 事务大小限制时会拒绝迁移，不能无日志地拆分提交。

`workspace status` 识别正常服务运行文件并检查描述符 / owner 对应关系，未知或不完整运行文件仍报告待检查。服务是否可连接请使用已鉴权的 service status；不要按 PID 或待检查计数删除运行目录。

## 验证

`pnpm check` 包括 schema 生成一致性、类型、lint、格式及测试。M2 测试实际启动 HTTP 服务，覆盖两个角色 / session、范围和版本冲突、关闭与撤销后的安全重试、过期/配置变化、真正进程崩溃接管、迁移准备阶段退出和精确回滚。所有数据使用独立临时目录，不访问真实模型或 Codex 全局配置。
