# 数据校验结构

v0.2 的[统一契约](../docs/contracts.md)另外规划 ConnectionGrant、Binding、HostEvidence、ContextDelivery 和宿主摘录来源；它们尚未加入当前生成结构。packages/protocol 已提供 agent 请求与准入校验，Core 支持 conn_/bind_/acc_ ID，但未写入新的持久结构。插件协议版本与持久 schemaVersion 独立，未来扩展需显式修改 Core schema、迁移和允许路径，不手工添加占位 JSON Schema。

这里的 19 份 JSON Schema 由 packages/core/src/schemas.ts 生成，使用 Draft 2020-12。运行时校验与 TypeScript 类型来自同一份 Zod 定义。

运行 pnpm schemas:generate 更新，pnpm schemas:check 检查漂移。不要手工编辑生成的 JSON。

JSON Schema 描述单条记录的结构，不替代文件读取与领域规则。例如清单引用是否存在、默认语言是否属于 languages、包路径是否经过 junction、摘要是否匹配，需要 Core 的角色加载器与存储层检查。记录间的状态转换、来源归属和宿主隔离证据将在后续里程碑实现。

P1 提供 Character、Workspace、CharactersLock、Work、Source、Session、Run、Message、Memory、ContextSnapshot、Proposal 和适配器能力、请求、事件的结构。定义这些结构不意味着相应业务命令已经实现。

P2 增加 WriteLock、Transaction、Receipt、RevisionManifest。作品增加 contentDigest，版本清单包含元数据与历史摘要链，建议稿 origin 区分用户和未来的模型运行。

Codex 最小闭环新增 CodexReply，Session 增加 activeRunId，Run 增加 owner、resultDigest，ExecutionRequest 可绑定作品版本，完成事件可携带隔离审计。长期记忆操作尚未实现。

参考：[Zod 的 JSON Schema 转换文档](https://zod.dev/json-schema)。
