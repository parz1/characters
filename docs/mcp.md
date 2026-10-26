# MCP 网关与 Codex 接入准备

2026-10-25：M4 通用网关已实现；M5 已有通用包、prepare/doctor 和实际 Codex 无模型协议测试，生产宿主验证器与真实原生闭环仍未完成。没有修改现有 Codex daemon、插件开关或默认记忆。

## 合成闭环

```powershell
pnpm install --frozen-lockfile
pnpm demo:m4 --workspace D:/projects/characters/.local/validation/NEW_EMPTY_DIRECTORY
```

路径必须不存在或为空；非空目录直接拒绝，不用默认 `.local/data`。脚本安装 Koto，启动临时服务，经真实 MCP SDK 客户端和 stdio 子进程完成：加载设定 → 候选搜索不可见 → 管理端确认 → 新授权/新模拟 session 检索到 → 撤回后不命中。最后显式关闭两个绑定、客户端和服务，保留合成审核记录供检查。全部数据为合成数据，使用管理端明确选择的 relaxed；不是实际 Codex 会话隔离证据，也不调用模型。

## 管理端显式配对

先按 [service.md](service.md) 初始化、迁移、安装角色并运行服务。为明确选定的真实宿主线程创建独立授权；不要复制示例线程标识冒充当前线程：

```powershell
pnpm characters connection grant --workspace PATH --host codex-cli --plugin characters --host-session ACTUAL_THREAD_ID --character koto --action discover --action bind --action context.read --action memory.search --action memory.propose --ttl 300 --json
pnpm characters gateway pair --workspace PATH --connection CONNECTION_ID --host-session ACTUAL_THREAD_ID --json
```

用结构化输出中的真实 `grant.id` 与 `pairingRef`。配对入口使用管理身份核对授权的 session、状态和期限，把服务世代和凭证引用写入工作区受保护的 `.runtime/service/gateway-CONNECTION_ID.json`。文件不含 token；网关只读取对应的 agent token，不能选择管理员 token。默认 strict，无可信服务端验证器时 bindings_open 失败；不应通过默认改成 relaxed 绕过。

启动网关（通常由宿主插件启动）：

```powershell
node packages/mcp/dist/stdio.js --workspace PATH --pairing PAIRING_REF
```

每个工具调用必须由已配对的可信本地宿主连接附加 `_meta.threadId`，且匹配管理员配对值。工具 arguments 中的 threadId、clientInfo、CWD、PID 或模型保证不能替代它；这仅关联会话，不证明宿主记忆政策。新 session 使用新授权。MCP 发现/握手不占用配对；首次匹配的有效工具请求独占占用，第二个活动进程返回 BUSY。正常退出释放占用；崩溃遗留占用时创建新授权，不自动判断宿主是否仍存活或删除锁。

## 工具与边界

六个工具：`characters_list`、`bindings_open`、`context_get`、`memory_search`、`memory_propose`、`bindings_close`。工具 schema 从统一协议生成；arguments 格式：

```json
{ "requestId": "11111111-1111-4111-8111-111111111111", "params": {} }
```

上例用于 characters_list。其他 params 按 tools/list 公布的 schema 填写。未知字段、操作、actor、路径或 token 被拒绝；审核和授权没有 MCP 工具。重试需保留同一 requestId 与全部参数，服务仍重新检查授权、绑定和证据。网络错误不保证未提交，不能换 requestId 盲重发。

网关启动及每次请求检查服务描述、协议 v1、操作集和固定世代；RPC 带世代头，服务在处理前再次核对。服务重启需重新授权/配对；网关不自动建库、恢复存储、启动服务、离线缓存记忆或停止其他客户端的服务。HTTP 请求/响应和 stdio 输入缓冲上限 256 KiB，MCP 工具结果（含文本与结构化副本）上限 1 MiB，工具同时在途上限 32，RPC 超时 15 秒。stdout 仅 MCP，错误不回显输入或凭证。

## Codex 包准备

```powershell
pnpm characters plugin codex prepare --output NEW_EMPTY_PLUGIN_PATH --json
pnpm characters plugin codex doctor --json
```

不指定工作区时生成通用模板，占位符未替换不能直接安装。同时指定 `--workspace PATH --pairing REF` 可生成本机配置，要求授权 hostId=codex-cli、pluginId=characters；此输出含显式机器路径，不能作为通用包分发。prepare 只写明确指定的空目录，不安装、不写宿主设置。分发源位于 `plugins/codex`，不含角色设定、记忆、凭证或机器路径。包版本 0.1.0，领域协议 v1，MCP SDK 1.32.2。

兼容清单沿用 M0 的 `.codex-plugin/plugin.json` 与 `.mcp.json`。实际 Codex 测试在独立 home/本地市场中读取此生成包，确认技能说明可被识别、六项工具可发现、未配对线程被拒绝，且线程操作不改共享配置。测试不发起模型请求、不使用真实凭证；它不证明技能路由到模型、角色遵循度、完整工具预算或真实后台记忆排除。官方[插件打包说明](https://developers.openai.com/plugins/build/plugins)描述了技能与 MCP 组合；目标版本格式仍以本地实测为准。

doctor 当前返回 `strictReady:false`，宿主记忆读取/生成和现有会话控制仍为 unknown/unavailable。生产会话的可信策略验证器、原生模型交互及 fork/恢复/压缩尚未验收；不能把上述包/工具测试或 M0 实验升格为 strict 证据。关闭绑定不清除聊天，也不重新开启含私有角色历史线程的记忆生成。
