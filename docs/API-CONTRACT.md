# 已核对的 Pi API

固定基线：Pi v1.3.0。以下来源是官方仓库，不依赖社区插件的描述。

- [Extension 文档](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/extensions.md)
- [类型声明](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/src/core/extensions/types.ts)
- [嵌套调用实现](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/src/core/nested-tool-calls.ts)
- [AgentSession 分派与 loadout](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/src/core/agent-session.ts)
- [原生 Bash factory](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/src/core/tools/bash.ts)
- [MCP readiness 和注册](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/src/extensions/mcp/index.ts)
- [官方 SDK 示例](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/examples/sdk/14-codemode-mcp.ts)

| API | 本 PoC 的使用方式 |
|---|---|
| `pi.registerTool` | Bash 同名包装、其他工具不同名代理、bg_task |
| `pi.getAllTools` | Schema、元数据、exposure、来源签名 |
| `pi.getSettings` | 执行时读取有效 Shell 设置；加载期不访问 |
| `prepareLoadout(loadout)` | 观察 callable/registered 定义和 executionMode |
| `hiddenDeclarations` | 不对模型声明原工具，仍保留内部可调用性 |
| `reachesTools` | 让原生 MCP 等待相关服务器就绪 |
| `ctx.tools` | 执行期确认原工具可调用及顺序属性 |
| `ctx.executeTool(name,args,{signal,onUpdate})` | 复用原工具验证、权限和结果钩子 |
| `input.streamingBehavior` | 原生 steer 来时 detach；返回 continue |
| `registerShortcut` | Ctrl+Shift+B |
| `tool_execution_end` | 等最终 wrapper 结果确认后再入队完成通知 |
| `ui_prompt_start/end` | 审批期间暂缓 detach |
| `sendMessage` | followUp + triggerTurn，完成唤醒 |
| `appendEntry` | 非模型上下文的审计事件 |
| `session_shutdown/session_tree` | 撤销旧 runtime、隔离通知 |
| `registerMcpServer` | 仅开发示例注册真实本地 MCP 服务器 |

## 没有使用的能力

没有虚构 `decorateTool`、`detachTool`、`tools_changed`、全局 `pi.executeTool`。没有访问 `_toolRegistry`、`_extensionRunner` 或修改 prototype。也没有通过改 provider payload 偷改模型看到的 Schema。

`src/protocol.ts` 保留可用于 FakePi 的最小结构，但通过 type-only import 引用官方 SDK 1.3.0 的结果、Usage、Schema、loadout/AgentTool 元数据、事件返回值和快捷键类型。注册定义的 promptGuidelines 必须为 mutable string[]；只读注册表观察仍可接受 readonly string[]。运行态 AgentTool 与扩展 ToolDefinition 分开，TSchema 先在 schema 边界验证再装饰。

`test/sdk-contract.compile.ts` 随 `npm run check` 编译：直接将真实 ExtensionAPI 传给 install，将生成工具交给正式 registerTool，将真实 ExtensionToolContext/ToolLoadout 赋给消费接口，并检查原生 Bash factory、入口 ExtensionFactory。负向断言确认非法 readonly 注册 guidelines、半截 Usage、非法事件返回/快捷键、同步 command handler 被拒绝。没有 as any、@ts-ignore 或修改 SDK。`index.mjs` 同时启用 @ts-check。

类型编译、无模型 SDK smoke、真实 TUI 行为测试分层报告；任何一层单独通过都不代表所有宿主行为通过。

实现没有依赖 `pi.getAllTools()` 取得原 execute，因为该接口没有这个字段。Bash 使用公开原生 factory，第三方工具使用 `ctx.executeTool`。

## 语义限制

`hiddenDeclarations` 只影响请求声明；原工具可能仍被其他编排器发现。路由守卫与代理配合，但不作为插件权限安全边界。

嵌套调用的 `nestedCalls` 和 usage 归父工具结果记录。父工具提前返回后，后台结果由本 PoC 自己保存；不会假设原父记录会被 Pi 自动补齐。

原工具的 timeout、HTTP/stdio 连接、MCP cancellation/elicitation 语义继续由 Pi 原生实现决定。后台化不延长 MCP request timeout，也不表示服务器支持 MCP Tasks。

## 最终结果与取消

ctx.executeTool 的 Outcome.isError 是最终裁决，可能由 afterToolCall 修改而与 result.isError 不同。v0.1.4 将其单独持久化；bg_task result 按最终裁决返回，保留原结果文件。cancelRequestedAt 不参与错误分类。父前台取消传原 signal.reason，手动后台取消发独立 controller.abort()；底层都使用原生 executeTool/MCP 通路。

ui_prompt_end 后使用 setImmediate 延后恢复 detach/通知，给原生权限 Promise 的拒绝裁决结算机会。实际 select 菜单与无 UI fallback 分层验证，不把代理模拟选择等同真实用户授权。
