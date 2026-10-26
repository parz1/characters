# characters Codex 接入包 0.1.0

这是通用插件骨架，使用 M0 验证过的兼容清单，不包含角色设定、私人记忆或凭证。
`pnpm characters plugin codex prepare --output NEW_PATH` 只生成模板，不安装、不改宿主配置。
模板中的三个占位符必须由管理端替换；不要直接安装仓库模板。
也可明确传入 `--workspace PATH --pairing REF`，生成本机专用配置；此输出不用于分发。

先运行服务并为当前真实线程创建单独 connection grant，再用 `gateway pair` 核对 hostSessionRef。
网关要求宿主提供 `_meta.threadId`，缺失或跨线程均拒绝。clientInfo、CWD、PID 和模型参数不能配对。
同一授权只支持一个活动网关；正常退出释放进程占用，崩溃后创建新授权，不自动清除旧占用。
新的线程使用新授权和新配对。启动/退出角色通过 bindings_open / bindings_close，不能通过插件开关实现。

`plugin codex doctor` 目前明确报告 strictReady=false：尚无生产当前会话策略验证器。
即使 MCP 可用也不能据此声称宿主记忆已隔离；strict 绑定默认失败。
relaxed 只适用于管理端明确授权的合成数据测试，不满足真实 strict 验收。
实际 Codex 原生交互、技能路由、fork/恢复/压缩、完整工具预算与后台记忆排除仍待验证。
不调用模型、不读取模型凭证、不修改现有 daemon、全局记忆或插件设置。
