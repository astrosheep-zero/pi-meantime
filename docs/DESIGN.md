# 设计说明与决策记录

版本：0.1.4 PoC。宿主目标：Pi 1.3.0。

## 1. 范围

本实现只扩展 Pi，不修改其核心、不使用子 Agent。支持两种用户诉求：模型预先选择后台执行，用户在运行中通过快捷键或 steer 要求继续其他工作。

实现采用两类 adapter 和一个 runtime：

```text
model -> bash + __background__ -> Pi 原生 Bash factory ------+
                                                           |
model -> original_bg + __background__ -> ctx.executeTool ---+--> TaskRuntime
                                         |                 |      |
                                原工具校验/权限/钩子         |      +--> TaskStore
                                         |                 |      +--> completion outbox
                                      MCP/扩展工具          |      +--> bg_task 查询
                                                           |
Ctrl+Shift+B / steer / auto timeout -> 只释放 foreground wait-+
```

Bash 用原生 factory 保留 Shell 选择、命令前缀、环境、超时和进程清理语义。运行时才调用 `pi.getSettings()`；加载期只构造无 settings 的基础定义，以免在 Pi runtime 未绑定时访问只允许运行期使用的 API。

其他工具只代理其名称和参数，**不抓取/缓存第三方 execute 函数**。每次通过 `ctx.executeTool` 分派到当前注册的原工具，避免重连后仍指向陈旧连接。

## 2. 两个生命周期

任务执行和前台等待分别建模。一个任务有 execution state 和 delivery state 两个轴：

```text
execution: running -> completed / failed
                   -> cancel_requested -> failed / completed
                   -> controller lost without final result -> outcome_unknown

delivery: foreground -> background
```

“completed”表示工具调用成功返回，不自动表示某个工具自行提交的外部作业也已完成。“failed”表示调用返回错误，不宣称副作用被回滚。

运行时持有独立 AbortController。前台阶段，父 signal 的真正取消会转发到任务；detach 时拆除这条关系。detach 以后父回合结束、下一轮的取消，都不会误杀已交给后台的任务。显式 `bg_task cancel` 或 `/bg cancel <id>` 请求取消该任务。

所有 detach 触发最终进入同一个方法。没有 `ctx.abort()`，没有捕获再重投用户输入。`input` 返回 `continue`，Pi 自己继续处理输入文本、附件和队列。

`no` 模式是严格前台，用户快捷键也不强行破坏它。

## 3. 调用进入门槛

仅仅调用 `ctx.executeTool()` 就立刻返回父结果有风险：嵌套调用可能仍在等 Pi 的顺序队列；Pi 真正分派原工具时会读取当前 assistant message。

代理为每个父调用创建 ticket。只有看到匹配的嵌套 `tool_call`，才允许 detach。此时原调用已由 Pi 的管线建立上下文。这个门槛不会绕过原来的权限或队列；如果原调用尚未进入，后台请求会等待。

这提供更稳的归属关系，但不把嵌套调用 API 变成官方独立任务 API。多层嵌套、SDK 自定义全局顺序模式和晚到 UI 交互仍要在实际宿主中验收。

## 4. 工具声明、可调用性和绕行

复制原工具的 exposure：`direct`→`direct`、`codemode`→`codemode`、`deferred`→`deferred`；`hidden`、`model-only` 不代理。Pi MCP 默认 `codemode`，因此相应 `_bg` 代理从 Codemode 中调用，**不会升级成模型直连工具**。注意 Codemode 的工具列表也可能同时包含原工具和 `_bg` 代理；默认 `blockOriginalCalls` 阻止绕过，但这不等于从 Codemode 描述中消除原始工具。

原工具保持原 exposure 和注册状态。`bg_task.prepareLoadout` 用 `hiddenDeclarations` 去掉已有代理的原工具直接声明。原工具 `hidden` exposure 不可用于这里，因为它会同时阻断内部调用。

只有继承 direct 的代理直接向模型声明；codemode/deferred 代理保持间接调用。代理的 `reachesTools` 明确返回原工具名，供 Pi 的 MCP readiness hook 使用。

隐藏声明不等于访问控制。Codemode 的工具发现、历史消息或其他插件仍可能知道原名。默认还用 `tool_call` 路由守卫：只有对应代理 ticket 发起的原调用通过；普通直接调用原名返回使用代理名的提示。这个守卫服务于一致路由，不宣称构成针对恶意扩展的安全沙箱。

权限检查仍在原调用管线发生。某些权限扩展可能同时询问代理和原工具，PoC 不会为消除重复询问而跳过原审批。

## 5. Schema 装饰与结果契约

`__background__` 是顶层保留属性。包装前检测声明和 required 列表中的冲突。双下划线降低碰撞概率，没有协议级保留名保证。

支持显式 object-root 输入 Schema，复制后直接添加控制属性。保留 required、additionalProperties 和所有嵌套 Schema。**不用 Type.Intersect/allOf 拼接**，因为原对象关闭额外属性时，交叉类型会拒绝新控制参数。

根级组合、条件、patternProperties、propertyNames、property-count、const/enum 等需要更复杂的等价变换；PoC 拒绝包装并保留原工具。没有偷偷放松业务约束。调用原工具时再次经过 Pi 的原始参数验证。

代理返回统一 envelope：`task + result_available + result`。因为同一输入可以返回原结果或后台句柄，照抄原 outputSchema 会撒谎。本 PoC 明确改变编程调用者看到的输出包装，保留原业务结果的存储副本。

## 6. 动态注册与生命周期

没有假设 Pi 存在通用 `tools_changed` 事件。

- `session_start` 和 `before_agent_start` 扫描注册表。
- `prepareLoadout` 观察公开 loadout，排到微任务后同步，不在该回调内递归注册。
- `mcp_servers_change` 触发重扫，但不被当成完整的工具列表变化通知。
- 500ms 的有界扫描覆盖迟到注册、Schema 更新和没有事件的变化。
- 注册签名稳定时不重新注册，不反复污染上下文和缓存。
- 原工具消失/隐藏、变得不兼容时撤下自己的代理，原工具不被修改。
- 名称超过长度限制时使用稳定 hash 后缀；遇到他人占用名称就放弃包装。撤下路径也不会覆盖后来占据该名称的第三方工具。

工具注册和工具列表变化之间有公开 API 无法完全消除的同步窗口。执行期再次检查当前原工具和签名，失败时不启动操作。

## 7. 通知与消息归属

只有满足全部条件才入队完成通知：后台执行已结束、原 wrapper 的结果已被宿主最终确认、结果还未被主动读取、当前 runtime/会话仍有效。

最终确认同时验证 tool-call ID 和 task UUID，防止旧会话迟到事件遇到重复 call ID。快完成的前台任务不发第二次通知。

通知只包含 task ID、工具名和状态，不把原始工具输出变成额外的指令消息。模型需要结果时通过 `bg_task result` 读取，仍经过该工具自己的结果管线。

采用 `followUp + triggerTurn:true`；多项完成合成一条消息。同步入队失败最多重试三次。`queued`只表示 sendMessage 调用已成功返回，不等于模型必然收到。宿主接口没有投递确认，进程崩溃时不宣称 exactly-once。重启后不自动投递历史通知，避免旧任务打断新工作。

## 8. 取消、关闭与恢复

Bash 使用 Pi 原生进程清理；MCP/一般扩展工具仍经原名 ctx.executeTool 和 Pi 原生 AbortSignal 通路。v0.1.4 不因取消请求额外推断远端结局。最终 Outcome.isError（包括 afterToolCall 的最终裁决）决定 failed/completed，result payload 保留原样；元数据单独记录 isError，避免把旧 payload.isError 冒充最终裁决。cancelRequestedAt 仅记请求事实。真正未收到最终 outcome 的控制丢失/存储失败才保留 outcome_unknown。旧版 endedAt 的 unknown 记录可读取原结果，取消幂等，不重分类历史。

`/reload`、会话切换、树切换和退出采用相同的保守策略：停止旧通知、请求取消、等待有限 grace，未结束的本地 producer 记 outcome_unknown。**本版不承诺 reload 保活。**

进程全局配额只保留存活 producer 的租约，不保留旧宿主上下文。非协作任务在实际 Promise 结束前不释放配额，防止反复 reload 绕过并发上限。Pi 进程退出后，这种保护自然结束；这不等于能追踪失联的远端作业。

恢复读取同会话结果文件，未完成记录投影为 outcome_unknown，不恢复 Promise、不盲目 kill PID、更不重放原请求。

每条任务有 producerId，只有创建它的 runtime 可写生命周期。恢复 runtime 是观察者：status/list/result 从磁盘刷新；不把本地的 recovered/outcome_unknown 投影写回。观察者读到结果后只对最新记录合并 notification=observed。原 producer 在写结果前核对所有权，元数据更新使用同步 read/merge/rename；已有 endedAt 且 localRunning=false 的终态证据不可被关闭旧快照倒退。queued/observed 确认不会被旧关闭路径改回 suppressed。

这些操作在同一个 Node/Pi 进程内不跨 await，因此 reload runtime 之间不会交错 read-modify-write。没有跨进程文件锁/事务协议；不支持两个 Pi 进程同时打开同一 owner 存储目录，也不承诺突然进程退出时 metadata/result 两文件的事务原子性。

## 9. 存储、大小与成本

每个会话使用 hashed 目录，目录 0700、文件 0600；写临时文件再原子 rename。task ID 严格校验，拒绝结果文件 symlink。这个本地存储位于当前 OS 用户的信任域，不能代替文件系统或沙箱隔离。

不保存业务入参和环境变量。结果可能含敏感数据，因此采用私有权限，但不做自动内容脱敏；保留原工具结果钩子的脱敏结果。

运行状态和完成数据分别保存；完成后从内存释放大结果。默认保留最近完成的128个任务；尚未最终确认的前台结果、等待通知的结果、仍有全局存活租约以及没有 endedAt 的不确定任务暂不淘汰。通知 flush 和最后租约释放后立即再次清理，无需等待新任务。显式读取结果时优先保留刚返回条目，避免同一次调用给出失效的 resultPath；后续清理事件仍可按保留策略淘汰它。恢复时不先 slice(maxRetained)，防止隐藏仍应保护的任务。元数据与对应结果一起删除，删除失败会保留内存记录并暴露 storageError/审计事件。单结果4MiB；超限存储显式截断清单。模型正文/结构化 inline 视图均有预算，任务列表默认10条、最多32条并支持 offset。

入站工具已经构造出来的超大结果，在截断前仍可能占内存，PoC 无法用结果截断阻止上游一次性分配。用户移除整个结果目录时会失去历史数据；PoC 不自动跨会话清理其他目录。

原始 `usage` 在任务结果中保留。前台嵌套 usage 由 Pi 自动归到父调用，包装器不重复加一次；后台晚到 usage 的 Pi 全局汇总可能不完整。PoC 不修改 Pi 的历史费用记录。这是明确的已知宿主集成缺口，不是通过测试的指标。

## 10. 验收层级

1. Runtime/Schema/Store 单元测试。
2. 公共接口宿主替身下的适配器和事件测试。
3. 同一适配器配真实本地 Shell 和真实 MCP JSON-RPC/stdio 传输。
4. 实际 Pi SDK、provider 消息投影和 TUI/RPC 集成。

当前各层的验证范围与复跑方法见 [VALIDATION.md](VALIDATION.md)。仓库不包含原始运行日志或会话证据。

## 10. 审批与手动操作（v0.1.4）

Pi 的 ui_prompt_end 可能早于权限钩子的 Promise 结算。prompt 结束后保留一轮 setImmediate 屏障，期间所有 detach、通知排队/flush 继续暂停，让原生拒绝先成为错误结果；不能用“菜单已关闭”推断“审批通过”。这覆盖本次验证的同步 select 结果后直接返回裁决，不为任意插件另加的长期异步裁决作保证。

/bg cancel 必须一个完整 ID；缺失/多参数只显示当前会话列表与用法。查找仅限会话 owner，完成后的重复取消不再发 AbortSignal。/bg status 展示 ID、工具、状态、取消请求/recovered 标志，不展示内部 producerId 大 JSON。后台回执保留结构化元数据，同时告诉人可输入的命令。

操作反馈使用公开 ui.setWidget 的同 key 字符串数组，标记 Latest background control，仅显示最近一次操作，不污染模型上下文、不抢焦点。原因是 Pi 1.3.0 info notify 的旧状态行会在重绘时引用最新共享文本；本扩展不修改该上游实现。状态列表运行中优先、每页三项，/bg status <offset> 可访问后续项；会话停止和开始均清面板。它不是永久操作历史。
