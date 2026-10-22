# Pi 宿主接口边界

目标版本：**Pi 1.3.0**。同名管理复用官方执行 helper，但不是仅靠公开 ExtensionAPI 实现的插件；升级宿主需要重新核对 adapter。

## Pi 1.3.0 接口与本扩展用法

| 接口 | 用途 |
|---|---|
| `pi.getAllTools()` / `AgentSession.getAllTools()` | 读取元数据；同步捕获 session 时经过被临时拦截的方法 |
| `session.getToolDefinition()` | 取得真实工具定义，而非从元数据接口虚构 execute |
| execute 传入的 `ctx` | 按属性描述符派生 job 上下文，不调用 runner 的 context factory |
| loader runtime `refreshTools()` | 同步包装：原生 refresh → reconcile 实际获胜定义 → 仅定义被修改时再次原生 refresh |
| `pi-agent-core.runToolCall` | carrier 执行、原生错误转换及最终结果处理 |
| `ctx.executeTool()` / `ctx.tools` | job 上下文保留原生嵌套分派和可调用性 |
| `input` / `registerShortcut` | steer 返回 continue；快捷键请求 detach |
| `tool_execution_start/end` | 原始参数/父链、临时 start 清理及句柄发布确认 |
| `tool_call` | 只关联 validated input 的弱身份与代次；不决定权限、不启动任务 |
| `ui_prompt_start/end` | 审批期间暂停 detach 和通知 |
| `session.sendCustomMessage()` / `session.subscribe()` | 请求边界无触发暂存、空闲唤起的 Promise 及公开 message_end 消费确认；不使用可清除的 core steering 队列 |
| `appendEntry()` | 非模型上下文的任务索引 |
| before_agent_start、turn_end、settled、compact、tree 事件 | 请求边界交接及受 Stop/失败暂停约束的恢复 |

`registerTool` 仅添加 meantime 控制工具，不替代 Bash 或注册受管工具别名。原 prepareLoadout、exposure、来源与描述保留；builtin Codemode 和 tool_search 不替换。不存在 blockOriginalCalls 路由守卫、注册表轮询配置或旧代理兼容层。

## 非官方接缝

普通 ExtensionAPI 没有“当前 AgentSession”或围绕原生 producer 的 middleware。因此 adapter 同步临时替换导出的 `AgentSession.prototype.getAllTools`，调用 `pi.getAllTools()`，在 finally 按归属立即恢复；随后只按 session 拦截私有 `_afterToolCall`（不改 `_beforeToolCall`）。包装公开 loader runtime `refreshTools()`、修改真实 ToolDefinition 和挂接私有回调均是 monkeypatch，**不是官方支持的扩展协议**。refresh 包装先让宿主选择获胜定义，再装饰，必要时第二次原生刷新；动作全程同步，无注册表轮询、不修改 runner 方法、不解析私有工具优先级。

所有修改只在属性仍为本扩展所有时恢复。入口通过 Pi Jiti `require` 加载宿主及内部模块，并将宿主 AgentSession 传给 captureSession，避免原生 ESM 取得本地开发 SDK 副本。每个 session 复用一个常驻 after fence，不串联退休 adapter；换代只换 token。对象/数组以公开 `tool_call.input`（即 execute / after 的 validated args）为 WeakMap 键，值只含 token 和原始 start 元数据，不持有退休 runner。旧 snapshot handler 即使在 dispose 后恢复也标记旧 token，不向新代次捐赠 admission。after 在原生处理/跳过前消费标记；没有 after 的对象标记随 args 回收。只有未管理的 primitive-root input 使用 ID fallback，after/end 清理；最终 shutdown 后 host 已撤掉的晚到 no-after primitive 标记可留到 session GC，不加常驻订阅。primitive fallback 不支持相同 ID 的重叠复用；对象结果 fence 不依赖 ID 隔离。start 临时表在 tool_call/end/dispose 清除；异常中断 start 且没有 end 的记录最多留到本代 dispose。fence 不卸载，对无标记及当前代次调用透传原 after；这是唯一不按归属恢复的修改。旧执行中子调用仍受 fence 保护；runner / loader runtime 身份及代次检查隔离旧 finalizer、嵌套调用。内部 session 连接端口仅用于确定性测试，不增加用户配置。

## 一次准备，一次执行，一次最终处理

控制字段在原参数 preparer 前移除；原生准备、校验和完整权限链各一次。公开 start 发生在 prepareArguments 之前，保存任何 raw input（包括可由原 preparer 修复的 JSON 字符串）；公开 tool_call 只建立弱身份关联。execute 入口本身证明完整权限链通过，使用最终 validated / mutated args，才读取 raw mode（primitive 默认为 auto，native Codemode 固定 auto）。

官方 runToolCall 使用未注册的同名空参数 carrier，无 before hook / repair。carrier 调用保存的原 execute 和捕获的真实 session after 管线各一次，保留原 name / call ID / parentId；结果完全 finalized 后才交 runtime 保存。成功 admission 时仅跳过外层重复 after；失败 admission、拒绝及无效调用保留外层原生处理。原工具钩子不处理后台句柄。

最终 `Outcome.result` 原样交 runtime 保存，`Outcome.isError` 独立保留为权威裁决，即使它不同于 payload 的 isError 也不改写保留结果。前台外部返回由 `foregroundOrHandle` 投影权威错误位；wait 回执、状态与 completion 索引采用该独立裁决。partial updates 不是最终结果钩子脱敏后的输出；finish 清除暂存 progress，结束任务预览与通知尾部只取最终结果。carrier 使用类型完整的最小 assistant/context stub，不保留原 transcript；这依赖 Pi 1.3 `_afterToolCall` 只读取 toolCall 的 ID/name、args、result/isError，升级须重审。job 上下文从 execute 的 ctx 派生，保留不可枚举属性及 guarded getters；覆写 ctx.signal，并向原 executeTool 显式传 `options.signal ?? jobSignal`，避免原闭包默认 signal 仍属于旧前台。

## 兼容性边界

- 顺序执行、hidden / model-only exposure、不支持的输入 Schema 和保留字段冲突不改变原语义。没有 outputSchema 的原工具用 `{}` 描述原生输出或句柄，以保留 Codemode 结构化句柄。
- 晚到嵌套记录及 usage 不保证补齐已完成父消息或全局统计；不生成额外晚到 transcript 结果。
- 原工具 timeout、MCP cancellation / elicitation 仍受宿主和远端约束；后台化不是 MCP Tasks 服务。
- 树导航取消/失败缺少宿主结束事件，通知只能等待后续可用事件重试。真实终端、远端交互和协作取消的验证边界见 [VALIDATION.md](VALIDATION.md)。

参考：[Extensions](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/extensions.md)、[SDK](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/sdk.md)、[AgentSession](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/src/core/agent-session.ts)、[runner](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/src/core/extensions/runner.ts)。以安装版本声明和实现为准。
