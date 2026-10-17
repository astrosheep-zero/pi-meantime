# pi-meantime

纯 Pi Extension 的后台工具执行 PoC。目标接口固定为 **Pi 1.3.0**，不修改 Pi 核心，不启动第二个 Agent。

`bash` 同名包装；符合条件的 MCP / 扩展工具保留原注册，创建 `<original>_bg` 代理。代理逐个**继承原工具 exposure**：`direct` 仍为 `direct`，`codemode` 仍为 `codemode`，`deferred` 仍为 `deferred`；`hidden`、`model-only` 不生成代理。只有 direct 工具在代理激活后隐藏原工具的模型声明，原工具仍供内部 `ctx.executeTool()` 调用。所有入口共享一个 Runtime，统一支持模型主动后台化、Ctrl+Shift+B、steer 和前台等待超时。Pi 1.3.0 的 MCP 默认 exposure 是 `codemode`，无需为了此 PoC 强制升级为 `direct`。

**v0.1.4 修复版**：取消保留 Pi 最终原生错误位和原始结果，不再把已返回的取消错误推断为 outcome_unknown；新增手动 `/bg cancel <id>`、可读状态列表，并修复审批拒绝前抢先发后台句柄的竞态。继续保留 v0.1.3 的 reload 晚结果、保留策略和真实 SDK 类型修复。验证范围与复跑方法见 [验证说明](docs/VALIDATION.md)。

## 开始试用

需要已经安装的 Pi 1.3.0 和 Node.js 22.19+。建议在独立测试目录/会话试用，不与其他覆盖 `bash` 的插件同时加载。

```sh
cd pi-meantime
pi -e ./index.mjs
```

此方式临时加载扩展，不修改 Pi 核心，也不自动写入全局扩展列表。入口由 Pi 加载，复用宿主提供的 `@earendil-works/pi-coding-agent`。

不启动 Pi 也能跑全部本地测试和演示。运行它们不需要 API Key、模型调用或运行时 npm 依赖：

```sh
npm test
npm run demo
```

TypeScript 开发检查使用锁定的官方 SDK 1.3.0、`typescript` 和 `@types/node`（仅类型引用，不向运行时状态机引入 SDK）：

```sh
npm ci --ignore-scripts
npm run check
```

### 带真实本地 MCP 测试服务器启动

完整源码包包含一个开发用 MCP stdio 服务器。服务器只有延迟、回显、故障和取消测试能力。

```sh
PI_BG_CONFIG="$PWD/examples/bg-poc.json" \
  pi -e ./index.mjs -e ./examples/register-fixture.mjs
```

这个测试配置把自动 detach 阈值降为 1 秒。默认配置为 120 秒。`/bg` 或 `/bg status` 分页列出当前会话任务（运行中优先，每页三项，`/bg status 3` 看下一页）；`/bg cancel <完整任务ID>` 请求取消指定任务；不填 ID 会显示用法和任务列表，不猜目标。`/bg rescan` 主动重扫代理。测试服务器由 `pi.registerMcpServer()` 注册，由 Pi 自己建立 MCP 连接。

模型工具调用示例，不是终端命令：

```js
bash({ command: "npm test", __background__: "yes" })

// 下述 fixture 使用 exposure: direct，以展示直接调用。
// MCP 默认 codemode 时，请从 Codemode 调用同名 _bg 代理。
mcp__bg_poc_fixture__slow_bg({
  ms: 5000,
  text: "fixture finished",
  __background__: "yes"
})

bg_task({ action: "list" })
bg_task({ action: "status", id: "bg_..." })
bg_task({ action: "result", id: "bg_..." })
bg_task({ action: "cancel", id: "bg_..." })
```

也可以让模型调用 `slow_bg` 时省略 `__background__`，运行中输入新要求，或按 Ctrl+Shift+B。前台等待释放，底层任务继续，当前工具正常返回句柄。

## 参数约定

| `__background__` | 意义 |
|---|---|
| `"auto"`，默认 | 从前台开始；允许快捷键、steer、自动等待阈值触发 detach |
| `"yes"` | 请求立即后台执行；仍要通过原调用进入门槛，遇到当前 UI 审批会延后 detach |
| `"no"` | 保持前台；拒绝所有 detach 触发；真正取消仍有效 |

只接受这三个字符串，故意不混用 boolean。控制字段只从顶层剥离，嵌套业务对象里的同名字段不变。原 Schema 声明了该保留字段时拒绝包装，不会覆盖它。

`autoDetachMs` 是“等多久后放到后台”；Bash 原有 `timeout` 仍是“命令最多活多久”。二者分离。

手动命令反馈显示在编辑器附近的 Latest background control 面板，下一次操作替换，不作为永久历史或实时任务状态；任务结束后可用 /bg status 刷新，切会话清理。

Ctrl+B 保留 Pi 编辑器原有用途。本 PoC 使用 **Ctrl+Shift+B**，终端不能传递该组合键时使用 `/bg detach`。

## 模型看到的形态

```text
bash(command, timeout?, __background__?)
mcp__server__operation_bg(原业务参数..., __background__?)
bg_task(action, id?, offset?, limit?)
```

对于 `codemode`/`deferred`，原工具和 `_bg` 代理可能都列在 Codemode 的候选工具中；默认 `blockOriginalCalls` 阻止通过原名绕过，但不会从 Codemode 列表物理移除原工具。

原 MCP Tool 仍可被内部 `ctx.executeTool(originalName, args, {signal})` 调用。代理名称不同，避免同名递归。

两种正常返回：

```json
{"task":{"id":"bg_...","state":"running","delivery":"background"},"result_available":false}
```

```json
{"task":{"id":"bg_...","state":"completed"},"result_available":true,"result":{"original":"structured result"}}
```

这是包装器的 **统一输出 envelope**。输入业务 Schema 保留；输出 Schema 没有假装与原工具完全相同。前台成功也会带 task 元数据。原结果正文仍呈现给模型，原 `content`、`details`、`structuredContent`、`usage` 在大小预算内落盘。原工具没有结构化结果时，envelope 的 `result` 是文本。

图片不自动塞进模型上下文，保存在结果文件。超大结构化结果的 inline `result` 为 `null`，按 `task.resultPath` 读取保留结果。超过整个结果保留上限时明确标记 `resultTruncated`；不会宣称保留了完整原文。

## 配置

只读取全局 `~/.pi/agent/bg-poc.json`，或显式绝对路径 `PI_BG_CONFIG`。尊重 `PI_CODING_AGENT_DIR`。不自动加载项目目录中的配置。

| 配置 | 默认值 |
|---|---|
| `include` | `["mcp__*"]` |
| `exclude` | IDE MCP，以及 `read/write/edit/codemode/tool_search` |
| `autoDetachMs` | `120000`；`0` 关闭计时自动 detach |
| `maxRunning` | `4`，按真实本地 producer 计数 |
| `maxRetained` | `128` 个已结束任务 |
| `maxResultBytes` | `4194304`，单任务保留结果上限 |
| `reconcileMs` | `500`，注册表重扫间隔 |
| `shutdownGraceMs` | `1000`，取消/关闭等候上限 |
| `notifyDebounceMs` | `50`，完成通知合并窗口 |
| `blockOriginalCalls` | `true`，普通直接调用原名时提示使用代理 |
| `storageRoot` | 全局 agent 目录下 `bg-poc-tasks` |

需要包装其他自定义扩展工具时，把名字/模式加入 `include`，例如 `["mcp__*", "my_slow_tool"]`。`hidden`、`model-only`、不可调用或明确 `sequential` 的原工具不包装；不把交互工具、文件写入和强制顺序约束粗暴改成后台。

## 已实现与边界

已实现：独立取消信号、无 abort 的 detach、参数冲突检测、动态代理同步、原调用验证/权限/结果钩子保留、结果文件、完成通知合并和入队失败重试、任务查询与分页、来源会话隔离、跨 reload 的本地存活配额保护。

需要明确接受的 PoC 边界：

- **会话内后台，不提供跨进程继续执行。** `/reload`、会话切换、树切换、退出都请求取消并停止旧通知。恢复时未完成任务标记 `outcome_unknown`，绝不自动重放。旧 producer 若随后真正完成，同一会话的恢复 runtime 会在 status/list/result 时刷新成功结果；退出不会覆盖终态证据。
- 取消和原生调用使用相同 AbortSignal/MCP 取消通路。`cancelRequestedAt` 只记录请求事实；原调用最终 `Outcome.isError=true` 映射为 failed，false 映射为 completed，原始结果另行原样保存（在配置的大小上限内）。不从请求取消推断远端结果；远端不合作是原生调用同样存在的边界。真正失去本地执行控制且尚无最终结果时仍显示 outcome_unknown。
- `ctx.executeTool()` 仍用 Pi 原生嵌套调用队列。不会释放或绕过 Pi 的顺序锁。底层排队时，“yes”可能等待到原调用进入后才返回句柄。
- 后台工具的晚到 usage 保存在任务结果里；**Pi 会话全局费用统计可能漏掉父工具返回后的 usage**。PoC 不伪造修正值，不重复计费。
- 复杂根 Schema 拒绝自动包装。动态工具列表也存在短暂同步窗口，无法凭公开 API 做原子工具注册装饰器。
- `print/json` 的 `auto` 留在前台，`yes` 返回明确错误，避免进程退出吞掉后台结果。
- 已打开的 UI 审批期间延后 detach；已经后台化后才发生的 MCP elicitation/交互是尚未完整验收的宿主兼容边界，应对这类工具使用 `no` 或排除规则。

完整边界与设计依据见 [设计文档](docs/DESIGN.md)、[新版 API 对照](docs/API-CONTRACT.md)、[验收清单](docs/VALIDATION.md)。

## 目录

```text
index.mjs                  Pi 入口；宿主 Bash factory 和实时 settings
src/extension.ts           注册、代理同步、hiddenDeclarations、输入/完成事件
src/runtime.ts             producer/observer 分离的任务状态机
src/schema.ts              保留参数、Schema 检查、稳定代理名
src/store.ts               私有目录、原子快照、大小限制和恢复读取
src/config.ts              配置验证
src/protocol.ts            由固定 SDK 类型约束的最小接口子集
scripts/demo.ts            宿主替身 + 真实 MCP 通信的可执行模型视角演示
scripts/pi-smoke.mjs       安装真实 Pi SDK 后运行的独立冒烟测试
examples/register-fixture.mjs  用新版 API 注册本地 MCP 测试服务器
```

MIT License。尚未发布 npm。GitHub 仓库：https://github.com/astrosheep-zero/pi-meantime。

## RPC 客户端接入

TUI 的最近操作面板位于输入编辑器上方；RPC 模式没有内置可视面板。客户端需消费 `extension_ui_request` 的 `setWidget`（键 `bg-control`）、`setStatus`（键 `bg-poc`）及 `notify`。本版未指定 widgetPlacement；客户端负责选择显示位置，字段省略的清除事件也需处理。若客户端忽略这些事件，手动命令反馈可能不可见；当前没有能力协商或降级显示。

通过 RPC `prompt` 发送 `/bg status` 或 `/bg cancel <id>`。返回 `success:true, disposition:handled` 仅表示命令已处理，不能据此认定取消成功；错误 ID 的说明另走 `notify(error)`。完成提醒是 `message_end` 的 `customType: bg-poc-completion` 消息并触发 follow-up。原生 RPC `abort` 停止前台回复，不取消已经 detach 的后台任务。`hasUI=true` 表示协议桥接存在，不代表客户端已经渲染。
