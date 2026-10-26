# 工作区管理服务（M2 / M3）

`startService(workspace)` 只持有显式工作区，监听 `127.0.0.1` 随机端口。HTTP 管理面和 agent 面使用不同凭据；统一入口为鉴权的 `POST /v1/rpc`，没有匿名健康检查或 CORS。

`ManagementStore` 编排 Core 的 schema、WAL、版本检查和回执。服务生命周期锁独立于短事务写锁；网络验证不持有写锁。返回边界与撤销在服务队列中串行化，回执重放前重新鉴权并检查绑定。服务重启使旧世代绑定中断。

可信 `HostVerifier` 是进程创建时注入的服务器接口，不是 RPC、模型参数、证据文件导入或管理员的“已验证”开关。默认 CLI 没有生产验证器，因此拒绝 strict 绑定；模拟验证器只在隔离测试中使用。

管理服务不控制宿主推理、任务或记忆设置。session 关联来自管理员明确配对的授权；真实 MCP 元数据的可信配对需要 M4/M5，不能用手写 session 名称证明宿主隔离。

使用与边界见 [service.md](../../docs/service.md)。

M3 的上下文、记忆候选、审核、检索和共享背景由 Core KnowledgeStore 实现，服务只提供鉴权、会话绑定与事务编排。参见 [memory.md](../../docs/memory.md)。
