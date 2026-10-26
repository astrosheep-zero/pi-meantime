# 设计说明

宿主目标严格限定为 Pi 1.3.0，升级须重新核对接缝。对齐基线是**不安装 pi-meantime 时的同一个工具**。扩展不修改 Pi 核心、不启动第二个 Agent；同名工具获得调度能力，TaskRuntime 负责前后台等待、取消、保存和通知。

## 同名工具与宿主适配

```text
原名调用 → 原生参数准备 / 校验
         → _beforeToolCall 标记 token/raw/parent
         → 原生权限链（完整执行一次）
         → 原 execute 的同名包装 → TaskRuntime admission
           → runToolCall 最小 carrier → 已保存的原 execute
             → 捕获的原生 after 管线 → 最终 Outcome → runtime
         ← 前台最终结果，或后台句柄
```

不注册工具别名、不屏蔽原名，也不替换 builtin codemode 或 tool_search 的定义。`codemode` 不重复注册：meantime 通过 facade 调用官方 `createCodemodeExtension`，通过 facade 的 `appendEntry` 加入 store 写入 guard；官方内建本身没有这个 guard。capture 后 `manageTools` 按 `sourceInfo.path === "builtin:codemode"` 认领真实内置 definition，只原地包装其 execute；schema、grammar、prepareLoadout、renderers、来源与对象身份不变。同一个名字自然用于直接声明、Codemode 的描述 / ALL_TOOLS / searchTools，以及独立 tool_search；没有第二个候选争夺声明预算。若用户禁用 builtin 或 SDK 未加载，尊重设置，不自动补一份；真实第三方同名替换 warning 不隐藏。SDK 需要整段托管时，须提供命名 `builtin:codemode` 的 InlineExtension（`{ name: "codemode", builtin: true, ... }`），非命名的自定义 codemode 不被当作原生定义认领。carrier/fence/scope 桥全部保留。SDK 自定义 options 与 store guard 归属见 [API-CONTRACT.md](API-CONTRACT.md)。

Pi 的普通 ExtensionAPI 没有 current-session 或 around-producer 中间件。窄宿主 adapter 因此依赖 **Pi 1.3.0 的非官方集成接缝**：

- 同步临时拦截导出的 `AgentSession.prototype.getAllTools`，调用 `pi.getAllTools()` 捕获真正的当前 session，在 `finally` 中立即恢复；不跨 await 留下全局 prototype 补丁。入口通过 Pi Jiti `require` 加载宿主和内部模块，并把运行宿主的 AgentSession 传给 captureSession，避免 Node 原生导入本地 SDK 副本破坏类身份。
- 按代次包装 session `_beforeToolCall`：在 await 原生权限链前，用 `context.args` 的 WeakMap 记录 token、`context.toolCall.arguments` raw 和 parent；权限仍由原 hook 完整执行，不决定/不重跑。`_afterToolCall` 仍是每 session 常驻 fence；before 在 dispose 按归属恢复原 descriptor/原型 lookup。两者都是私有 monkeypatch，不是官方扩展 API；不调用 `extensionRunner.createToolContext`。
- 包装 loader runtime 的公开 `refreshTools()` 边界：先原生 refresh 让宿主选择实际获胜定义，再 reconcile 并原地装饰；仅原始定义发生修改时第二次原生 refresh，重建复制的 AgentTools。整个动作同步完成、无轮询；不拦截 runner 注册表，也不自行解析私有 custom-tool 优先级。公开方法被 monkeypatch，不等于官方支持此拦截方式。

工具定义原地修改，不另注册竞争定义。名称、label、原生 description、来源、exposure、namespace、annotations、constrained sampling、原 renderers 和 prepareLoadout 保持原语义。控制说明集中在参数 Schema 和共享 system prompt。Bash 走相同路径，不覆盖其 factory 或另造 Bash 实现。内部 install 可注入 session 连接端口供确定性测试使用；这不是公共配置。

## 参数与完成边界

支持的 object-root Schema 通过 `decorateSchema` 增加可选 `__background__: "auto" | "yes" | "no"`，不放松业务约束。根级复杂组合、条件、pattern/property 限制和保留字段冲突仍拒绝接管。原生工具管理 Bash 与内置 CodeMode；CodeMode 只包装 execute，不装饰 Schema。非原生工具（包括 Square 与内置 MCP 提供的外部工具）默认全部管理，再按 include/exclude 筛选；除内置 CodeMode 的 model-only 声明外，hidden、model-only、sequential 工具保持原样。宿主全局顺序执行时不 detach。

控制字段在原 `prepareArguments` **之前**剥离，mode 只保存在内部调用数据中；原准备、校验和全部权限处理各一次。TaskRuntime admission 在原名 execute 内、权限处理全部结束后发生。拒绝、无效调用及容量不足不能启动原生副作用；权限钩子修改后的业务参数不再次校验。没有自派发递归或 readiness ticket。

adapter 在 `_beforeToolCall` 进入原生权限链前，用 `context.args` 弱键记录 token、`context.toolCall.arguments` raw 和 parent；execute 用最终 validated args 取回同一 frame。只读取这些字段，不保留完整 ToolCall 或 before context，不重跑权限。producer 使用官方 `pi-agent-core.runToolCall`，传入未注册的同名最小 carrier：空参数、无 before hook / repair、类型完整的最小 assistant/context stub。Pi 1.3 的 after 不读取 assistant/context，仅使用 ID/name、最终业务参数及结果；这是版本特定约束，升级必须复核。carrier 的 execute 仅调用一次已保存的原 execute，其 after 回调仅调用一次捕获的真实 session `_afterToolCall`。错误转换、图片处理、钩子字段合并、structuredContent 失效规则及最终 `Outcome.isError` 由原生管线负责，不复制其实现。

只有成功 admission 的调用跳过外层冗余 `_afterToolCall`；后台句柄不进入原工具结果钩子。被拒绝、无效或 admission 失败的调用仍走正常外层完成路径。runtime **只接收完成全部原生结果处理的 Outcome**，原样保留 `Outcome.result`，另存权威 `Outcome.isError`，不把错误位写回保留结果。仅在前台外部返回时由 `foregroundOrHandle` 将权威错误位投影到返回对象，不带 task envelope；detach 后返回句柄，wait 回执与任务状态使用独立错误位。不补造晚到 tool-result transcript entry。partial updates 仍走原生更新路径，不能声称已经过最终结果钩子脱敏；finish 删除暂存 progress，结束任务的终端预览和通知尾部只使用最终结果，不沿用 pre-hook partial。

outputSchema 在原生 Schema 存在时扩为“原生输出或后台句柄”；原定义无 outputSchema 时用 `{}`，让 Codemode 也能读取结构化句柄。实际结果保持原生 content、details、structuredContent 和错误语义。

## 生命周期、信号与动态注册

任务执行与前台等待分开。job 使用独立 AbortController：detach 前父取消传入，detach 后解除父取消关系；显式 cancel 请求 job 取消。执行上下文从原 execute ctx 派生，保留属性描述符，包括不可枚举的 tools / executeTool 和 guarded getters；真实 execute、ctx.signal 和嵌套默认 signal 都归 job 所有。executeTool 明确转发 `options.signal ?? jobSignal`，不沿用原 ctx 闭包内的前台 signal；tools getter 和 executeTool 仍检查代次有效性。嵌套调用仍由原生分派保留 name 和 parent ID。

重注册、MCP 重连和撤回/恢复通过同步 refresh → reconcile → 必要时再 refresh 处理，不轮询或重复包装；CodeMode 的认领也走这条路径，runner 重建后重新识别 `builtin:codemode`，dispose 只恢复仍属于本扩展的 execute 包装。关闭先停止 admission，再关闭 runtime，最后 dispose：撤销代次并按属性归属恢复。每个 session 仅一个常驻 after fence，换 runner 只换代次 token，不捕获前代 adapter。before 在权限链前写入 frame，挂起审批跨 reload 仍保留旧 token；execute/after 只接受当前代次，旧 frame 不向新代次捐赠 admission。after 消费 frame 并隔离旧结果；对象/数组 frame 以 `context.args` 为 WeakMap 键，未执行的对象 frame 随 validated args 回收；primitive-root 用 ID fallback，由 after / `tool_execution_end` 清理，最终 shutdown 后晚到 no-after 标记待 session GC。ID fallback 不承诺重叠复用 ID 的隔离，对象 fence 按 args 身份隔离。不再订阅 `tool_call`，也不维护 start 表或 host.start 关联；`tool_execution_start` 只记录 steer 父链，`tool_execution_end` 发布句柄并清理 primitive fallback；两者都不再保存 raw。before 按代次安装并在 dispose 恢复原 descriptor/原型 lookup；after fence 永久保留。会话替换重新绑定，runner / loader runtime 身份及代次检查阻止旧 finalizer、嵌套分派、索引和通知进入新 runtime。

用户 steer、快捷键和 detach 命令仍共用 runtime 门槛；输入返回 continue，不 abort 或 consume/resubmit。提前的用户意图只沿仍存活的调用及父链继承，不传给新回合或新会话。UI 审批期间及 ui_prompt_end 后一轮 setImmediate 屏障暂停 detach / 通知，避免把菜单关闭当作批准。`no` 只关闭计时转后台。print/json 的 auto 保持前台，yes 报错。

## 保存、通知与取消

runtime 行为不因同名适配改变：

- 只有实际 detach 才保存任务索引并返回句柄；普通索引写入失败留在前台。关闭请求取消并在有限 grace 后释放等待，停止旧会话通知。不承诺 reload 保活。
- 后台结果已落定、句柄已被宿主确认、结果未读且没有该任务的 waiter 时才 eligible。`CompletionDelivery` 集中处理交接、消费确认和宿主恢复；runtime 在调用 sink 前原子预留 `pending → queued`，宿主公开 `message_end` 才将仍 queued 的任务改为 `delivered`。queued 不参与保留裁剪；已读/已确认任务不因迟到失败回滚。
- 活动 run 的普通完成通知经公开 `session.sendCustomMessage(deliverAs:'steer', triggerTurn:true)` 进入 steering 快速通道；`before_agent_start` / `turn_end` 等待审批 continuation 后以 `triggerTurn:false` 暂存所有 eligible 批次，每条最多 16 项。`turn_end` 新暂存通知且 outcome 非 aborted/error 时请求一次 continuation；不使用暂存前的 canContinue 快照。wait 只抑制正在等的任务；已交接的通知不能撤回。
- settled 时只有宿主队列已空，才把未消费的快速通道通知退回 pending；队列未空说明原副本仍可能被后续 run 消费，不能重复补投。队列移除不消耗发送失败重试预算。空闲时使用 `session.sendCustomMessage(triggerTurn:true)` 的实际 Promise 唤起；准备失败只回退尚未消费的 queued 任务，并暂停自动唤起。`wakePaused` 只禁止 `triggerTurn:true`，不禁止安全投递：Stop 在宿主转为 idle 的 setImmediate 补写未消费通知，其后的空闲完成通知也同样以 `triggerTurn:false` append-only 交接，不自动复活模型；若用户已启动新 run，则由正常边界/快速通道接管。普通 settled、压缩完成/失败和导航成功统一经一个可取消的 setImmediate 重查宿主状态，再尝试空闲投递。关闭取消恢复回调并解除消费订阅，不重试旧代次。
- `delivered` 表示宿主消费，不是磁盘持久化回执：idle trigger 的公开 message_end 早于 session persistence；边界暂存路径则先 append 再 emit。不承诺崩溃 exactly-once 或严格 FIFO（idle trigger 准备期间暂存的新通知可能先显示）。
- 通知仅含状态、可选输出路径和约 1KiB 不可信文本尾部。单任务 wait 不另截断原生文本；批量 wait 共用 32KiB 正文预算；回执不内联图片。这些展示限制不修改保留结果。
- task / completion / removed 自定义 session 条目保留任务和最终错误位、文本、路径。同会话树导航共享任务；fork/clone 不接管旧作业。恢复只有文本与元数据，缺少 completion 时为 outcome_unknown，不重放业务、不补发历史通知。
- 不创建、扫描或删除原生输出文件，不二次清洗原生结果；终端显示单独处理控制序列。默认最多 4 个本地执行、保留最近 128 个结束任务；待通知等记录受保护。非协作 producer 的进程全局租约保留到真实 Promise 结束，不能通过 reload 绕过并发上限。

## 明确边界

取消是协作式请求，不保证远端操作停止或回滚；后台化不延长原工具超时。晚到远端交互仍是兼容边界，可用 exclude 排除这类工具。晚到嵌套 bookkeeping 和 usage 不保证补进已完成的父消息或 Pi 全局费用统计。

Pi 1.3.0 树导航取消/失败没有结束事件；积压通知保留 pending，但无后续事件时不保证自动补发。新 run 启动时会在首个模型请求前重试积压通知，不再等该 run settled；未被 Stop 或异步启动失败暂停时，普通 agent settled、压缩结束/失败或导航成功也会重试。此限制不是用轮询修补。

验证方法及未覆盖范围见 [VALIDATION.md](VALIDATION.md)；宿主接口边界见 [API-CONTRACT.md](API-CONTRACT.md)。
