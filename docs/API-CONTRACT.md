# Pi 宿主接口边界

目标版本：**Pi 1.3.0**。同名管理复用官方执行 helper，但不是仅靠公开 ExtensionAPI 实现的插件；升级宿主需要重新核对 adapter。

## Pi 1.3.0 接口与本扩展用法

| 接口 | 用途 |
|---|---|
| `pi.getAllTools()` / `AgentSession.getAllTools()` | 读取元数据；同步捕获 session 时经过被临时拦截的方法 |
| `session.getToolDefinition()` | 取得真实工具定义，而非从元数据接口虚构 execute |
| `session.extensionRunner.createToolContext()` | 构造原生工具上下文 |
| loader runtime `refreshTools()` | 同步包装：原生 refresh → reconcile 实际获胜定义 → 仅定义被修改时再次原生 refresh |
| `pi-agent-core.runToolCall` | carrier 执行、原生错误转换及最终结果处理 |
| `ctx.executeTool()` / `ctx.tools` | job 上下文保留原生嵌套分派和可调用性 |
| `input` / `registerShortcut` | steer 返回 continue；快捷键请求 detach |
| `tool_execution_start/end` | 存活调用/父链、frame 清理及句柄发布确认 |
| `session.subscribe()` | 不随 runner 换代失效的 execution-end 清理，覆盖没有 after 阶段的原生 immediate result |
| `ui_prompt_start/end` | 审批期间暂停 detach 和通知 |
| `sendMessage()` / `appendEntry()` | steer 完成通知，空闲时 triggerTurn；非模型上下文的任务索引 |
| session、settled、compact、tree 事件 | 生命周期隔离及通知重试 |

`registerTool` 仅添加 meantime 控制工具，不替代 Bash 或注册受管工具别名。原 prepareLoadout、exposure、来源与描述保留；builtin Codemode 和 tool_search 不替换。不存在 blockOriginalCalls 路由守卫、注册表轮询配置或旧代理兼容层。

## 非官方接缝

普通 ExtensionAPI 没有“当前 AgentSession”或围绕原生 producer 的 middleware。因此 adapter 同步临时替换导出的 `AgentSession.prototype.getAllTools`，调用 `pi.getAllTools()`，在 finally 按归属立即恢复；随后按 session 拦截私有 `_beforeToolCall` / `_afterToolCall`。包装公开 loader runtime `refreshTools()`、修改真实 ToolDefinition 和挂接私有回调均是 monkeypatch，**不是官方支持的扩展协议**。refresh 包装先让宿主选择获胜定义，再装饰，必要时第二次原生刷新；动作全程同步，无注册表轮询、不修改 runner 方法、不解析私有工具优先级。

所有修改只在属性仍为本扩展所有时恢复。入口通过 Pi Jiti `require` 加载宿主及内部模块，并将宿主 AgentSession 传给 captureSession，避免原生 ESM 取得本地开发 SDK 副本。每个 session 复用一个 after fence，不串联退休 adapter；换代只换 token，弱调用标记不持有退休 runner。prehook 阻断/抛错直接清理，公开 session execution-end 订阅清理没有 execute/after 的 immediate result；旧调用排空且无当前 owner 时，按归属恢复 after 并取消订阅。旧执行中子调用仍受 fence 保护；runner / loader runtime 身份及代次检查隔离旧 finalizer、嵌套调用。内部 session 连接端口仅用于确定性测试，不增加用户配置。

## 一次准备，一次执行，一次最终处理

控制字段在原参数 preparer 前移除；原生准备、校验和完整权限链各一次。admission 在同名 execute 内发生，之后以已准备业务参数执行，不重新校验权限钩子修改后的参数。

官方 runToolCall 使用未注册的同名空参数 carrier，无 before hook / repair。carrier 调用保存的原 execute 和捕获的真实 session after 管线各一次，保留原 name / call ID / parentId；结果完全 finalized 后才交 runtime 保存。成功 admission 时仅跳过外层重复 after；失败 admission、拒绝及无效调用保留外层原生处理。原工具钩子不处理后台句柄。

最终 `Outcome.result` 原样交 runtime 保存，`Outcome.isError` 独立保留为权威裁决，即使它不同于 payload 的 isError 也不改写保留结果。前台外部返回由 `foregroundOrHandle` 投影权威错误位；wait 回执、状态与 completion 索引采用该独立裁决。partial updates 不是最终结果钩子脱敏后的输出；finish 清除暂存 progress，结束任务预览与通知尾部只取最终结果。job 上下文保留不可枚举属性及原生嵌套分派，并将实际执行、ctx.signal、嵌套默认 signal 绑定到 job。

## 兼容性边界

- 顺序执行、hidden / model-only exposure、不支持的输入 Schema 和保留字段冲突不改变原语义。没有 outputSchema 的原工具用 `{}` 描述原生输出或句柄，以保留 Codemode 结构化句柄。
- 晚到嵌套记录及 usage 不保证补齐已完成父消息或全局统计；不生成额外晚到 transcript 结果。
- 原工具 timeout、MCP cancellation / elicitation 仍受宿主和远端约束；后台化不是 MCP Tasks 服务。
- 树导航取消/失败缺少宿主结束事件，通知只能等待后续可用事件重试。真实终端、远端交互和协作取消的验证边界见 [VALIDATION.md](VALIDATION.md)。

参考：[Extensions](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/extensions.md)、[SDK](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/sdk.md)、[AgentSession](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/src/core/agent-session.ts)、[runner](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/src/core/extensions/runner.ts)。以安装版本声明和实现为准。
