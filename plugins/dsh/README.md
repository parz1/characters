# characters for DeepSeek Harness

原生插件最小实现，SDK 基线 `@deepseek-ai/dsh-*@0.2.1-rc.3`，插件 0.1.0，characters 协议 v1。
提供六项公开操作与 `characters_status`，按真实 `exec.agent.id` 和有效工作目录匹配管理端配对。
无角色正文、私人记忆、凭证或机器路径；输出本机配置需显式 prepare。

插件安装不加载任何角色。先在目标 blog 会话调用 `characters_status` 取得原生会话 ID；
用户在 characters 管理端授权、配对。安装包可只配置 workspace 和项目范围，按原生会话查找唯一配对；新会话不必重装插件。模型不能自行授权或审核。
显式打开绑定后，每次原生提示词组装经服务重新取得 coauthor 上下文；required 动态上下文避免被完整系统提示词覆盖。其他 session 不受影响。
文章文件读写由 dsh 自己的权限和工具负责，characters 不新增文件执行入口。

配对不证明宿主记忆策略。当前没有真实已安装 dsh 会话的隔离/预算验收，doctor 返回 strictReady=false。
默认 strict 缺少可信验证器会拒绝角色正文，不能自行降级。只有管理端对单个授权明确选择 relaxed 才能加载角色内容；
这是用户知情的风险选择，不是 strict。不能把本地协议测试、relaxed 使用或参考客户端证据用作 dsh strict 证明。

关闭只结束绑定，不清除聊天；请新建会话后切换角色。不得用全局/项目插件开关、卸载或全局 reload
实现角色启停，不得重新开启含角色历史线程的宿主记忆生成。强制中断依赖授权期限或管理端撤销。

prepare 只写明确空目录，不安装、不修改任何宿主/项目配置。安装、重新配对和版本升级都是管理操作。
若实际 dsh 版本与 SDK 基线不同，保持拒绝，先做兼容性验证，不写版本豁免。
完整说明见仓库 docs/dsh.md。
