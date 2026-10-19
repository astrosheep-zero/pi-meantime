# 设计说明与决策记录

版本：0.2.0。宿主目标：Pi 1.3.0。

## 1. 范围

本实现只扩展 Pi，不修改其核心、不使用子 Agent。支持两种用户诉求：模型预先选择后台执行，用户在运行中通过快捷键或 steer 要求继续其他工作。

实现采用两类 adapter 和一个 runtime：

```text
model -> bash + __meantime__ -> Pi 原生 Bash factory ------+
                                                           |
model -> original_mt + __meantime__ -> ctx.executeTool ---+--> TaskRuntime
                                         |                 |      |
                                原工具校验/权限/钩子         |      +--> TaskStore
                                         |                 |      +--> completion outbox
                                      MCP/扩展工具          |      +--> meantime 查询
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

运行时持有独立 AbortController。前台阶段，父 signal 的真正取消会转发到任务；detach 时拆除这条关系。detach 以后父回合结束、下一轮的取消，都不会误杀已交给后台的任务。显式 `meantime cancel` 或 `/meantime cancel <id>` 请求取消该任务。

所有 detach 触发最终进入同一个方法。没有 `ctx.abort()`，没有捕获再重投用户输入。`input` 返回 `continue`，Pi 自己继续处理输入文本、附件和队列。

`no` 模式是严格前台，用户快捷键也不强行破坏它。`detachOnSteer` 默认 true；false 时 input 仍返回 continue，但不触发 detach。快捷键、显式命令和自动阈值独立工作。

## 3. 调用进入门槛

仅仅调用 `ctx.executeTool()` 就立刻返回父结果有风险：嵌套调用可能仍在等 Pi 的顺序队列；Pi 真正分派原工具时会读取当前 assistant message。

代理为每个父调用创建 ticket。只有看到匹配的嵌套 `tool_call`，才允许 detach。此时原调用已由 Pi 的管线建立上下文。这个门槛不会绕过原来的权限或队列；如果原调用尚未进入，后台请求会等待。

这提供更稳的归属关系，但不把嵌套调用 API 变成官方独立任务 API。多层嵌套、SDK 自定义全局顺序模式和晚到 UI 交互仍要在实际宿主中验收。

## 4. 工具声明、可调用性和绕行

复制原工具的 exposure：`direct`→`direct`、`codemode`→`codemode`、`deferred`→`deferred`；`hidden`、`model-only` 不代理。Pi MCP 默认 `codemode`，因此相应 `_mt` 代理从 Codemode 中调用，**不会升级成模型直连工具**。注意 Codemode 的工具列表也可能同时包含原工具和 `_mt` 代理；默认 `blockOriginalCalls` 阻止绕过，但这不等于从 Codemode 描述中消除原始工具。

原工具保持原 exposure 和注册状态。`meantime.prepareLoadout` 用 `hiddenDeclarations` 去掉已有代理的原工具直接声明。原工具 `hidden` exposure 不可用于这里，因为它会同时阻断内部调用。

只有继承 direct 的代理直接向模型声明；codemode/deferred 代理保持间接调用。代理的 `reachesTools` 明确返回原工具名，供 Pi 的 MCP readiness hook 使用。

隐藏声明不等于访问控制。Codemode 的工具发现、历史消息或其他插件仍可能知道原名。默认还用 `tool_call` 路由守卫：只有对应代理 ticket 发起的原调用通过；普通直接调用原名返回使用代理名的提示。这个守卫服务于一致路由，不宣称构成针对恶意扩展的安全沙箱。

权限检查仍在原调用管线发生。某些权限扩展可能同时询问代理和原工具，扩展不会为消除重复询问而跳过原审批。

## 5. Schema 装饰与结果契约

`__meantime__` 是顶层保留属性。包装前检测声明和 required 列表中的冲突。双下划线降低碰撞概率，没有协议级保留名保证。

支持显式 object-root 输入 Schema，复制后直接添加控制属性。保留 required、additionalProperties 和所有嵌套 Schema。**不用 Type.Intersect/allOf 拼接**，因为原对象关闭额外属性时，交叉类型会拒绝新控制参数。

根级组合、条件、patternProperties、propertyNames、property-count、const/enum 等需要更复杂的等价变换；扩展拒绝包装并保留原工具。没有偷偷放松业务约束。调用原工具时再次经过 Pi 的原始参数验证。

未 detach 的调用返回原生结果，不附加 task、不二次截断、不移除图片；结束后从 runtime 删除，由 Pi 原生会话历史保存结果，不创建自家存储目录或文件。Bash 原样重抛执行异常。代理保留嵌套调用 hook 后的结果及最终 Outcome.isError，但不重复上报 Pi 已自动聚合的 usage。

只有真正 detach 才返回 `task + result_available:false`；`meantime(action="wait", id=..., timeout=0)` 继续返回有预算的任务 envelope。Bash outputSchema 是原生输出与后台句柄的 union，并继承 constrainedSampling。通用代理通过 getAllTools 发现的元数据不含 outputSchema，暂用 `{}`（unknown）描述原生输出或句柄，不再虚报统一 envelope 类型。

同名 bash 的 tool_result 在前台结果或 detach 句柄返回时触发一次；detach 后晚结果不再触发该 bash hook。其他工具代理通过 ctx.executeTool 调原名，内层真实完成仍经过原工具 hook。meantime 读取结果另经过 meantime 自己的 hook。

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

Bash 任务保存完整命令供 wait 详情读取；任务列表和完成通知把命令合为单行、截取最多 120 UTF-8 字节的预览，截断时加省略号。不新增 name/description 入参。

通知包含 task ID、工具名、状态、Bash 命令预览，以及约 1KB 的文本输出尾巴；尾巴用 `<untrusted-output-tail>` 包裹并声明为不可信数据，不是指令。通知明确声明是自动完成消息，不是用户输入或批准；没有新信息时静默处理。尾巴只含文本，不含图片和结构化数据；尾巴或落盘结果截断都会标注 truncated。省去常见场景下多一轮 `meantime(action="wait", id=..., timeout=0)`；完整保留结果仍通过 `meantime(action="wait", id=..., timeout=0)` 读取。

采用 `followUp + triggerTurn:true`；多项完成合成一条消息。同步入队失败最多重试三次。`queued`只表示 sendMessage 调用已成功返回，不等于模型必然收到。宿主接口没有投递确认，进程崩溃时不宣称 exactly-once。重启后不自动投递历史通知，避免旧任务打断新工作。

`wait` 按 Node 定时器上限分段等待，不截断总等待时长。预先取消和等待中取消都终止等待，不取消 producer、不确认结果。恢复任务没有本地 Promise 可等待时立即返回当前状态。

## 8. 取消、关闭与恢复

Bash 使用 Pi 原生进程清理；MCP/一般扩展工具仍经原名 ctx.executeTool 和 Pi 原生 AbortSignal 通路。最终 Outcome.isError（包括 afterToolCall 的最终裁决）决定 failed/completed，result payload 保留原样；最终错误位与文本单独写入 completion 索引，避免把旧 payload.isError 冒充最终裁决。cancelRequestedAt 仅记请求事实；没有最终结果且失去本地控制时显示 outcome_unknown。

`/reload`、会话切换和退出请求取消、等待有限 grace，并停止旧通知。尚未结束的前台调用也经过后台晋升路径，记录索引再释放句柄。普通 detach 若索引写入失败则保持前台；强制取消/关闭仍可释放句柄并显示 storageError。**不承诺 reload 保活。** 同一会话内树导航共享任务，不重启 runtime、不请求取消；fork/clone 使用新 owner，不接管复制历史中的旧任务。

进程全局配额只保留存活 producer 的租约，不保留旧宿主上下文。非协作任务在实际 Promise 结束前不释放配额，防止反复 reload 绕过并发上限。Pi 进程退出后，这种保护自然结束；这不等于能追踪失联的远端作业。

恢复通过 Pi getEntries() 读取全部分支中的 meantime-index，按 owner 过滤并应用 task、completion 和 removed 记录。缺少 completion 的任务投影为 outcome_unknown；不恢复 Promise、不盲目 kill PID、更不重放原请求。晚到的超大工具文本文件可由 list/wait 暴露路径，但不证明执行结果。

旧 producer 只能写原 owner 目录的超大工具文本，不能向新会话追加索引或通知。通知、已读确认和重试都只在内存；恢复后不发历史通知。不支持两个 Pi 进程同时操作同一 owner 的存储。

## 9. 存储、大小与成本

每个会话使用 hashed 目录，目录 0700、文件 0600；写临时文件再原子 rename。task ID 严格校验，拒绝结果文件 symlink。这个本地存储位于当前 OS 用户的信任域，不能代替文件系统或沙箱隔离。

除用于辨识任务的 Bash 命令外，不保存业务入参和环境变量。结果可能含敏感数据，因此采用私有权限，但不做自动内容脱敏；保留原工具结果钩子的脱敏结果。

转后台时 Pi appendEntry 保存任务索引（id、tool、kind、command、mode、createdAt、detachReason）。绑定会话内完成时追加 completion（id、endedAt、isError、cancelRequestedAt?、exitCode?、text、truncated、outputPath?）。Bash 使用原生有界文本，路径优先 structuredContent.full_output_path，其次 details.fullOutputPath；不额外截断、不写扩展文件。其他工具 cleanText 后不超过 50KiB 的文本只进索引；更大时原子写入 `<sha256(owner)[0:32]>/mt_xxx.txt`，索引保留约 2000 字节预览和路径。图片和 structuredContent 只留当前进程内存，恢复只有文本，回执说明省略。

默认保留最近完成的128个后台任务；等待通知、仍有全局存活租约以及没有 endedAt 的不确定任务暂不淘汰。活跃 runtime 在完成、通知、读取时执行清理；关闭后的晚结果延后至原会话恢复清理。显式读取时优先保留刚返回条目。清理先删除扩展自己的工具文本文件（绝不删除 Pi 的 Bash 文件），再追加 removed 索引事件，防止恢复时复活为 unknown；删除失败保留索引与内存记录并暴露 storageError，后续可重试。文件和会话索引之间没有跨文件事务保证。

超大工具文本文件默认最多4MiB；只有文件本身被截断才标记 truncated，索引预览不等于丢失完整文本。任务列表默认10条、最多32条并支持 offset。旧版完成文件格式不迁移、不读取，也不自动删除。

入站工具已经构造出来的超大结果，在截断前仍可能占内存，扩展无法用结果截断阻止上游一次性分配。用户移除整个结果目录时会失去历史数据；扩展不自动跨会话清理其他目录。

原始 `usage` 只在当前进程的任务结果中保留。前台嵌套 usage 由 Pi 自动归到父调用，包装器不重复加一次；后台晚到 usage 的 Pi 全局汇总可能不完整。扩展不修改 Pi 的历史费用记录。这是明确的已知宿主集成缺口，不是通过测试的指标。

## 10. 验收层级

1. Runtime/Schema/Store 单元测试。
2. 公共接口宿主替身下的适配器和事件测试。
3. 同一适配器配真实本地 Shell 和真实 MCP JSON-RPC/stdio 传输。
4. 实际 Pi SDK、provider 消息投影和 TUI/RPC 集成。

当前各层的验证范围与复跑方法见 [VALIDATION.md](VALIDATION.md)。仓库不包含原始运行日志或会话证据。

## 10. 审批与手动操作（v0.1.4）

Pi 的 ui_prompt_end 可能早于权限钩子的 Promise 结算。prompt 结束后保留一轮 setImmediate 屏障，期间所有 detach、通知排队/flush 继续暂停，让原生拒绝先成为错误结果；不能用“菜单已关闭”推断“审批通过”。这覆盖本次验证的同步 select 结果后直接返回裁决，不为任意插件另加的长期异步裁决作保证。

任务 ID 为 `mt_` + 8 位 hex（生成时查重），不兼容旧版 `bg_<uuid>` 记录。/meantime cancel 与 meantime 工具接受完整 ID 或唯一前缀（可省略 `mt_`），前缀有歧义时报错并列出候选；缺失/多参数只显示当前会话列表与用法。查找仅限会话 owner，完成后的重复取消不再发 AbortSignal。/meantime status 展示 ID、工具、状态、取消请求/recovered 标志，不展示内部运行时大 JSON。后台回执保留结构化元数据，同时告诉人可输入的命令。

操作反馈使用公开 ui.setWidget 的同 key 字符串数组，标记 Latest background control，仅显示最近一次操作，不污染模型上下文、不抢焦点。原因是 Pi 1.3.0 info notify 的旧状态行会在重绘时引用最新共享文本；本扩展不修改该上游实现。状态列表运行中优先、每页三项，/meantime status <offset> 可访问后续项；会话停止和开始均清面板。它不是永久操作历史。

## meantime wait

工具仅暴露 `list | wait | cancel`，不兼容旧动作或 `timeout_ms`。`meantime(action:"wait", id, timeout?)` 阻塞到任务结束、超时或调用被中止，然后返回保留结果；运行中无结果时返回状态与 `result_available:false`。`timeout` 单位为秒，支持小数，默认 30，不设上限；`timeout: 0` 立即返回当前状态或结果。也可用 `ids` 配合 `mode: "any" | "all"`（默认 all）等待多个任务，使用相同的秒制超时。工具边界只转换一次为毫秒，runtime 内部仍用毫秒并分段处理 setTimeout 上限。wait 不取消任务。
