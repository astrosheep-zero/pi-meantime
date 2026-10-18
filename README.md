# pi-meantime

主命令 `/meantime`；`/bg` 是它的快捷别名，参数与行为完全一致。

纯 Pi Extension 的后台工具执行扩展。目标接口固定为 **Pi 1.3.0**，不修改 Pi 核心，不启动第二个 Agent。

`bash` 同名包装；符合条件的 MCP / 扩展工具保留原注册，创建 `<original>_mt` 代理。代理逐个**继承原工具 exposure**：`direct` 仍为 `direct`，`codemode` 仍为 `codemode`，`deferred` 仍为 `deferred`；`hidden`、`model-only` 不生成代理。只有 direct 工具在代理激活后隐藏原工具的模型声明，原工具仍供内部 `ctx.executeTool()` 调用。所有入口共享一个 Runtime，统一支持模型主动后台化、Ctrl+Shift+B、steer 和前台等待超时。Pi 1.3.0 的 MCP 默认 exposure 是 `codemode`，无需为了此扩展 强制升级为 `direct`。

**v0.2.0**：代理后缀改为 `_mt`，system prompt 新增简短的 meantime 说明；管理工具改名 `meantime`，控制参数改名 `__meantime__`，主命令 `/meantime`，保留 `/bg` 别名。配置改为 `meantime.json` / `PI_MEANTIME_CONFIG`，默认存储目录改为 `meantime-tasks`。从旧版升级时，将旧配置移至新路径。当前开发版简化了存储，不读取或迁移旧版 meta/result 文件，也不自动删除它们。

**v0.1.6**：`bg_task` 改为 direct，允许模型直接调用和 Codemode 内调用；真实 SDK 冒烟覆盖 detach → 后台完成 → 嵌套读取真实输出。

**v0.1.5**：未 detach 的 bash/代理调用保持原生结果；新增 `detachOnSteer` 开关，默认开启。关闭后 steer 仅由 Pi 排队处理，不触发转后台；快捷键、`/bg detach` 和自动阈值不受影响。

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
PI_MEANTIME_CONFIG="$PWD/examples/meantime.json" \
  pi -e ./index.mjs -e ./examples/register-fixture.mjs
```

这个测试配置把自动 detach 阈值降为 1 秒。默认配置为 120 秒。TUI 中 `/meantime`、`/bg` 或 `/meantime status` 打开实时任务面板：运行中优先，其余按创建时间从新到旧排列，显示状态与耗时；↑/↓ 选择，Enter 展开/收起完整命令、已有进度、最近输出尾部和结果文件路径，`c` 请求取消选中任务，Esc/`q` 关闭。面板由任务状态变化与每秒刷新驱动，关闭或切换会话即停止刷新。非 TUI 保留原文字列表；`/meantime status 3` 仍可查看下一页（三项一页）。`/meantime cancel <完整任务ID>` 请求取消指定任务；不填 ID 会显示用法和任务列表，不猜目标。`/meantime rescan` 主动重扫代理。测试服务器由 `pi.registerMcpServer()` 注册，由 Pi 自己建立 MCP 连接。

模型工具调用示例，不是终端命令：

```js
bash({ command: "npm test", __meantime__: "yes" })

// 下述 fixture 使用 exposure: direct，以展示直接调用。
// MCP 默认 codemode 时，请从 Codemode 调用同名 _mt 代理。
mcp__meantime_fixture__slow_mt({
  ms: 5000,
  text: "fixture finished",
  __meantime__: "yes"
})

meantime({ action: "list" })
meantime({ action: "status", id: "mt_1234abcd" })
meantime({ action: "result", id: "1234" }) // 唯一前缀，可省 mt_
meantime({ action: "wait", id: "1234", timeout_ms: 30000 })
meantime({ action: "wait", ids: ["1234", "mt_5678abcd"], mode: "any", timeout_ms: 30000 })
meantime({ action: "cancel", id: "mt_1234abcd" })
```

也可以让模型调用 `slow_mt` 时省略 `__meantime__`，运行中输入新要求，或按 Ctrl+Shift+B。前台等待释放，底层任务继续，当前工具正常返回句柄。

## 参数约定

| `__meantime__` | 意义 |
|---|---|
| `"auto"`，默认 | 从前台开始；允许快捷键、steer、自动等待阈值触发 detach |
| `"yes"` | 请求立即后台执行；仍要通过原调用进入门槛，遇到当前 UI 审批会延后 detach |
| `"no"` | 保持前台；拒绝所有 detach 触发；真正取消仍有效 |

只接受这三个字符串，故意不混用 boolean。控制字段只从顶层剥离，嵌套业务对象里的同名字段不变。原 Schema 声明了该保留字段时拒绝包装，不会覆盖它。

`autoDetachMs` 是“等多久后放到后台”；Bash 原有 `timeout` 仍是“命令最多活多久”。二者分离。

其他手动子命令的反馈显示在编辑器附近的 Latest background control 面板，下一次操作替换，不作为永久历史或实时任务状态；切会话清理。TUI 用 `/meantime` 打开上面的实时任务面板；非 TUI 的 `/meantime status` 仍返回文字快照。

Ctrl+B 保留 Pi 编辑器原有用途。本扩展 使用 **Ctrl+Shift+B**，终端不能传递该组合键时使用 `/meantime detach`。

## 模型看到的形态

```text
bash(command, timeout?, __meantime__?)
mcp__server__operation_mt(原业务参数..., __meantime__?)
meantime(action, id?, ids?, mode?, timeout_ms?, offset?, limit?)
```

对于 `codemode`/`deferred`，原工具和 `_mt` 代理可能都列在 Codemode 的候选工具中；默认 `blockOriginalCalls` 阻止通过原名绕过，但不会从 Codemode 列表物理移除原工具。

System prompt 的 `meantime` 章节简要说明：`_mt` 工具与原工具执行相同操作、接受相同业务参数，只多一个可选的 `__meantime__` 参数（`auto` / `yes` / `no`）。

原 MCP Tool 仍可被内部 `ctx.executeTool(originalName, args, {signal})` 调用。代理名称不同，避免同名递归。

**未 detach：保持原工具返回形态**，包括 content、details、structuredContent 和图片，不添加任务头、不额外截断；`auto` 在转后台前已完成也一样。Bash 异常原样重抛；代理采用原工具 hook 的最终错误位，嵌套 usage 由 Pi 聚合，不重复计算。结束后从内部记录删除，由 Pi 保存原生返回；扩展不创建任何任务文件或目录。

**真正 detach：返回后台句柄**：

```json
{"task":{"id":"mt_1234abcd","state":"running","delivery":"background"},"result_available":false}
```

完成通知包含状态、Bash 命令预览和约 1KB 文本输出尾巴，并明确标注自动消息与截断。`meantime(action="result")` 读取保留结果；`wait` 等到完成或超时后按相同格式返回（默认 30 秒，无上限；中止等待不取消任务）。成功读取会确认已读，无需额外 ack：

```json
{"task":{"id":"mt_1234abcd","state":"completed"},"result_available":true,"result":{"original":"structured result"}}
```

`wait` 也接受 `ids`（1–32 个任务 ID 或唯一前缀），与 `id` 必须二选一。`mode: "all"`（默认）等待所有任务，`mode: "any"` 等待任意一个任务结束；两者均受 `timeout_ms` 限制，中止只停止等待、不取消任务。已结束的结果按传入 ID 顺序拼接，共享单次结果的 32KB 正文预算，末尾 `Pending: ...` 列出尚未结束的任务。结构化输出为 `{ tasks: [...任务元数据及 result_available], pending: [...任务元数据] }`；成功读取确认已读，任何 ID 未知或前缀不唯一时在等待和确认前报错。

Bash 输出声明为原生输出与句柄的 union；通用代理暂声明 unknown，因为发现接口不提供原输出 Schema。`meantime` 仍使用任务 envelope。

同名 bash 的 hook 对前台结果或 detach 句柄触发一次，晚结果不再触发。其他工具代理的内层调用完成时仍经过原工具 hook；读取后台结果另走 `meantime` hook。

后台结果读取时，图片不自动塞进模型上下文，保存在结果文件。超大结构化结果的 inline `result` 为 `null`，按 `task.resultPath` 读取保留结果。超过整个结果保留上限时明确标记 `resultTruncated`；不会宣称保留了完整原文。

## 配置

只读取全局 `~/.pi/agent/meantime.json`，或显式绝对路径 `PI_MEANTIME_CONFIG`。尊重 `PI_CODING_AGENT_DIR`。不自动加载项目目录中的配置。

| 配置 | 默认值 |
|---|---|
| `include` | `["mcp__*"]` |
| `exclude` | IDE MCP，以及 `read/write/edit/codemode/tool_search` |
| `autoDetachMs` | `120000`；`0` 关闭计时自动 detach |
| `detachOnSteer` | `true`；设为 `false` 后 steer 不转后台 |
| `maxRunning` | `4`，按真实本地 producer 计数 |
| `maxRetained` | `128` 个已结束任务 |
| `maxResultBytes` | `4194304`，单任务保留结果上限 |
| `reconcileMs` | `500`，注册表重扫间隔 |
| `shutdownGraceMs` | `1000`，取消/关闭等候上限 |
| `notifyDebounceMs` | `50`，完成通知合并窗口 |
| `blockOriginalCalls` | `true`，普通直接调用原名时提示使用代理 |
| `storageRoot` | 全局 agent 目录下 `meantime-tasks` |

需要包装其他自定义扩展工具时，把名字/模式加入 `include`，例如 `["mcp__*", "my_slow_tool"]`。`hidden`、`model-only`、不可调用或明确 `sequential` 的原工具不包装；不把交互工具、文件写入和强制顺序约束粗暴改成后台。

## 已实现与边界

已实现：独立取消信号、无 abort 的 detach、参数冲突检测、动态代理同步、原调用验证/权限/结果钩子保留、结果文件、完成通知合并和入队失败重试、任务查询与分页、来源会话隔离、跨 reload 的本地存活配额保护。

需要明确接受的边界：

- **会话内后台，不提供跨进程继续执行。** `/reload`、会话切换、退出请求取消并停止旧通知；同一会话的树导航共享任务，fork/clone 不接管旧任务。转后台时用 Pi 会话自定义条目保存索引，完成时仅写一个含最终状态与结果的文件。恢复缺少结果的任务标记 `outcome_unknown`，绝不自动重放；旧 producer 的晚结果仍写入原目录，可由原会话在 status/list/result 时读回。通知与已读只留内存，重启不投递历史通知。
- 取消和原生调用使用相同 AbortSignal/MCP 取消通路。`cancelRequestedAt` 只记录请求事实；原调用最终 `Outcome.isError=true` 映射为 failed，false 映射为 completed，原始结果另行原样保存（在配置的大小上限内）。不从请求取消推断远端结果；远端不合作是原生调用同样存在的边界。真正失去本地执行控制且尚无最终结果时仍显示 outcome_unknown。
- `ctx.executeTool()` 仍用 Pi 原生嵌套调用队列。不会释放或绕过 Pi 的顺序锁。底层排队时，“yes”可能等待到原调用进入后才返回句柄。
- 后台工具的晚到 usage 保存在任务结果里；**Pi 会话全局费用统计可能漏掉父工具返回后的 usage**。扩展不伪造修正值，不重复计费。
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

TUI 的最近操作面板位于输入编辑器上方；RPC 模式没有内置可视面板。客户端需消费 `extension_ui_request` 的 `setWidget`（键 `bg-control`）、`setStatus`（键 `meantime`）及 `notify`。本版未指定 widgetPlacement；客户端负责选择显示位置，字段省略的清除事件也需处理。若客户端忽略这些事件，手动命令反馈可能不可见；当前没有能力协商或降级显示。

通过 RPC `prompt` 发送 `/meantime status` 或 `/meantime cancel <id>`。返回 `success:true, disposition:handled` 仅表示命令已处理，不能据此认定取消成功；错误 ID 的说明另走 `notify(error)`。完成提醒是 `message_end` 的 `customType: meantime-completion` 消息并触发 follow-up。原生 RPC `abort` 停止前台回复，不取消已经 detach 的后台任务。`hasUI=true` 表示协议桥接存在，不代表客户端已经渲染。
