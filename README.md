# pi-meantime

让长时间工具调用转到后台，Pi 继续处理其他工作；完成后通知模型，不必反复查询。
不修改 Pi 核心、不启动第二个 Agent。当前版本 **0.6.7**，面向 **Pi 1.3.0**，需要 **Node.js 22.19+**。

`bash` 与符合条件的 MCP / 扩展工具都用**原名**调用，只增加可选的 `__background__` 控制字段。没有代理别名或原名阻断；前台返回原生最终结果，后台保留完成原生结果钩子处理后的结果。实现依赖 Pi 1.3.0 的窄宿主 monkeypatch，并非仅使用官方扩展 API；见 [接口边界](docs/API-CONTRACT.md)。

## 安装

任选一种来源，安装后在 Pi 中 `/reload`：

```sh
# Git
pi install git:github.com/astrosheep-zero/pi-meantime

# npm（需要该版本已发布；不可用时使用 Git）
pi install npm:pi-meantime@0.6.7
```

也可克隆后临时加载，不写入全局安装列表：

```sh
git clone https://github.com/astrosheep-zero/pi-meantime.git
cd pi-meantime
pi -e ./index.mjs
```

其他修改同一工具执行路径的扩展可能与宿主适配冲突。

## 人怎么用

正常让模型执行工具即可。默认从前台开始，运行超过 **120 秒**自动转后台；运行中发送 steer 输入也可释放前台等待，但最早在调用进入执行后的 **3 秒**启动保护期结束时转后台。过早的 steer 会延迟到该期限处理，不忽略、不取消或重放执行，重复 steer 不延长保护期；期间完成的调用直接返回结果。**Ctrl+Shift+B**、`/meantime detach` 和显式 `"yes"` 不受此保护期限制，原有自动超时策略不变。`"no"` 只关闭计时转后台，不阻止这些用户操作；所有转后台仍须通过审批、调用进入和索引保存门槛。中断 `meantime wait` 仍立即释放等待，不取消底层操作。

| 命令 | 用途 |
|---|---|
| `/meantime` | TUI 打开实时任务面板；非 TUI 显示当前会话完整任务列表 |
| `/meantime detach` | 手动把允许转后台的前台调用转走；终端不支持快捷键时可用 |
| `/meantime cancel <id>` | 请求取消指定任务，不猜目标 |
| `/meantime rescan` | 重新检查受管工具定义 |
| `/bg` | `/meantime` 的别名，接受相同参数 |

面板运行中任务优先，其余按创建时间倒序；每秒及状态变化时刷新。
**↑/↓** 选择，**Enter** 展开/收起命令、已有进度、结束任务的输出尾部及输出路径，**c** 请求取消，**Esc/q** 关闭。
手动子命令反馈显示在 Latest background control 区域，只保留最近一次操作。

## 模型怎么用

以下是工具调用示例，不是终端命令。拿到任务 ID 就代表工作已启动，**不要重复执行原操作，也不要循环轮询**。

```js
bash({ command: "npm test", __background__: "yes" })

meantime({ action: "list" })
meantime({ action: "wait", ids: ["mt_1234abcd"], timeout: 30 })
meantime({ action: "wait", ids: ["1234"], timeout: 0 })
meantime({ action: "wait", ids: ["1234", "5678"], mode: "any", timeout: 60 })
meantime({ action: "wait", timeout: 30 })  // 等待当前所有未结束任务
meantime({ action: "cancel", ids: ["mt_1234abcd"] })
```

ID 用实际返回值替换；支持唯一前缀，可省略 `mt_`，有歧义时报错。

| `__background__` | 行为 |
|---|---|
| `"auto"`（默认） | 从前台开始，允许计时、快捷键、steer 或 detach 命令转后台 |
| `"yes"` | 请求立即后台执行；等待原调用进入，当前 UI 审批期间延后 |
| `"no"` | 关闭自动转后台 |

控制字段在原工具参数准备、校验和权限处理前移除；这些原生步骤各执行一次，全部权限通过后才进入任务运行时。Bash 自身的 `timeout` 仍是命令硬超时，与转后台阈值无关。

`meantime` 声明为 `model-only`：由模型直接调用，即使 `codemode.mode: "only"` 也保留声明，不改写 CodeMode 的工具可见性逻辑。脚本不能调用 `tools.meantime()`；脚本创建的后台任务应返回句柄，再由模型直接调用 `meantime` 管理。

`meantime` 只有三个动作：

- **list**：简短任务列表，默认 10 条；用 `offset`、`limit` 翻页，`limit` 最大 32。
- **wait**：等待结束或超时，返回当前状态或保留结果。`timeout` 单位为**秒**，默认 **30**，可用小数，无上限；**0** 立即返回。中止等待不取消任务。
- **cancel**：请求取消，不保证远端操作停止或副作用回滚；以工具最终结果为准。

`wait` 与 `cancel` 用 `ids` 指定任务，接受 1–32 项；`wait` 省略 `ids` 时等待当前所有未结束任务，`cancel` 必须给出。`mode: "all"`（默认）等全部结束，`"any"` 等任意一项结束；超时也会返回。批量回执含已结束结果及 `pending`，正文共享 32KiB 预算，被省略的结果可单独读取。

原生工具管理 Bash 与宿主内建的 CodeMode；`codemode` 定义按 `sourceInfo.path === "builtin:codemode"` 识别，meantime 只包装其 execute。非原生工具默认全部管理，包括 Square、普通扩展和 MCP（含 IDE MCP）。依据当前工具来源区分原生与扩展，同名扩展覆盖也属于非原生工具；include/exclude 可进一步筛选。原生名称、description、来源与 `direct` / `codemode` / `deferred` 可见性不变；从 Codemode 或 tool_search 发现后仍调用原名，不增加第二个候选。除上述原生 CodeMode 外，顺序工具、hidden / model-only 工具、不兼容的根 Schema 及保留字段冲突保持原样；宿主全局顺序执行时不转后台。

## 原生 CodeMode 整段后台执行

`codemode` 保留原名、raw JavaScript grammar、discovery、models、store 和原生 executor。没有第二套 sandbox，也不重写脚本。meantime 通过 facade 调用官方 `createCodemodeExtension`，通过 facade 的 `appendEntry` 加入 store 写入 guard，**不注册同名工具**；官方内建本身没有这个 guard。capture 后 `manageTools` 按 `sourceInfo.path === "builtin:codemode"` 识别真实内置 definition，仅包装其 execute，原 schema、grammar、prepareLoadout、renderers、来源与对象身份均不变。宿主桥只在当前实例保留 `_executeNestedToolCall`、原生 runner 的 `takeRecord`/`clear` 及 scope Map 的删除生命周期，drain 后按原 descriptor 归还，不替换全局 registry；carrier/fence/scope 桥全部保留。它不增加 `__background__` 参数：使用现有计时、Ctrl+Shift+B、steer 或 `/meantime detach` 分离**整段脚本的观察者**。CodeMode 根脚本与普通工具共用上述 3 秒 steer 启动保护，不另起脚本专用计时器。后续 await、局部变量、正常完成时的 `finally` 在同一次执行中继续，不重放脚本。

已知 SDK 限制：capture 使用默认 factory options，不保留 `models:false`；CLI 内置走默认 options，无影响。

若用户禁用 builtin 或 SDK 未加载 `codemode`，meantime 不会自动补一份，尊重现有设置；真实第三方同名替换 warning 照常显示，不隐藏。SDK 需要整段托管时，必须提供命名 `builtin:codemode` 的 InlineExtension（`{ name: "codemode", builtin: true, ... }`）；非命名的自定义 codemode 不会被当作原生定义认领。

- 普通子调用及其后代等待原生最终结果，不因计时、steer 或快捷键独立变成句柄；显式 `tools.someTool({...args, __background__: "yes"})` 仍可独立转后台。**脚本结束立即返回自己的结果**（包括 child handle），不等待独立子 producer，即使 `autoDetachMs: 0`。后代的 scope/记录有独立 drain 生命周期，晚到孙调用仍保留原 ID 和 usage；它们不继续占用已完成根脚本的前台观察者或 runtime admission。
- 原生限制不变：整个 Pi 进程**最多两个存活或正在退出的 CodeMode worker**。第三次执行立即返回原生容量错误；不排队、不自动重试，也不取消现有任务。`meantime` 保持 `model-only` 声明，在 `codemode.mode: "only"` 中仍由模型直接调用；list/wait/cancel 不需要第三个 worker。
- 中止 wait 不取消 producer；显式 cancel 中止作业所属 signal 链。原生硬取消可能终止 VM，**不保证执行 JavaScript `finally`**，也不保证远端副作用回滚。
- 树导航前、会话替换及 reload/shutdown 会请求取消并 drain 原生脚本及其 nested pipeline，再放行生命周期变化。非合作宿主子工具会延迟这个边界；grace timeout 不是已 drain 的证明。不承诺运行中的脚本跨 reload 存活。

### 完成记录与计费

前台完成通常由 Pi 的原生 toolResult 保存 nestedCalls/usage。后台已返回的句柄是 append-only 历史：**不会回写原 toolResult**。最终结果（包括图片、原生 details、结构化数据、nestedCalls 与 usage）关联原 `toolCallId`、`codemodeRootId` 和任务 ID，存进现有 `meantime-index` 的 completion 条目；重开会话可以恢复这些已完成结果。若脚本已结束但独立子 producer 尚未 drain，原观察者先返回；scope drain 后追加 `lateScope` completion，保留完整的最终嵌套 metadata，不回写原消息。

后台根任务完成时另追加一次公开 `SessionManager.appendUsage()` usage entry；仍有晚到后代时，仅在之后的 `lateScope` 条目追加尚未计费的 nested delta（根自身 usage 已由前台消息或后台完成计入）。显式子任务的晚到 usage 只归这条根 scope 记账，不在子记录重复计费。通知、单次/重复 wait 和重新打开后的 wait 都不再追加费用。wait 的 `details.usage`/`details.nestedCalls` 是保留元数据，不是新的执行 usage。

内存保留原生 Result 原对象；**落盘与 wait 回执使用提前完成 JSON 序列化校验的副本**。`details` 等字段若含 BigInt／循环引用等不可 JSON 序列化数据，该字段明确省略并列于 `persistenceOmissions`，可序列化 content、nestedCalls 和 usage 仍独立保存/计费。未知 details 不能推进一个写不进 JSONL 的会话 leaf；不把降级副本冒充原始完整数据。

这是一条**关联完成记录**，不是伪造的补充 toolResult；Pi 原生 HTML/compaction 不会自动把它识别成旧句柄的最终 nestedCalls。费用计入会话统计（`tools/codemode` usage 分类）；不要把关联记录误称为原生 transcript 已被补写。

## 完成通知、保存与边界

- 后台完成通知含任务 ID、状态、可选退出码、存在时的 `Output: <path>`，以及约 1KiB 的文本尾部。尾部标为不可信工具数据，不是指令，不含图片或结构化结果；需要更多信息时用单任务 `wait` 读取保留结果，或读取输出文件。
- TUI 展示为状态字形卡片：`✓/✕/⊘/●/?` 单通道表达完成/失败/取消/运行/未知，同一行给出命令、退出码、耗时和任务 ID；单任务通知附带输出尾部预览，展开查看完整尾部和输出路径。面向模型的说明文字不占用屏幕；`meantime` 调用行显示动作摘要（`wait mt_a, mt_b · 30s`）而不是原始 JSON。
- Agent 工作期间，完成通知先走 steering 快速通道，在 loop 下次拉取时可见；请求边界仍以 `triggerTurn:false` 暂存积压通知，空闲时唤起新一轮。UI 审批、压缩或树导航期间延后。每条最多合并 16 项，请求边界交接所有 eligible 批次。正在被 `wait` 等待或已成功读取的任务不再交接；超时或中断后未取得的结果仍会通知，已交接的消息无法撤回。
- 只有宿主 `message_end` 才确认消费，入队不等于送达。宿主队列排空后，未消费的快速通道通知返回本地 outbox；Stop 清队列后及其后的空闲完成通知都 append-only 补写，不自动重新唤起。单纯 abort 未清队列时保留原消息，不重复补投。空闲唤起准备失败后不再自动重试唤起，未消费通知由后续 idle flush 或下一合法请求以不触发方式补写。此确认不是磁盘持久化回执，不保证通知严格 FIFO 或崩溃场景下恰好一次。
- **Pi 1.3.0 已知缺口**：树导航取消/失败没有结束事件，期间积压的通知可能继续等待。任务仍保留 pending，可主动读取；下一次 agent settled、压缩结束等可用事件会重新尝试，不能保证无后续事件时自动补发。
- 任务索引及完成文本保存在 **Pi 会话自定义条目**中。同一会话的树导航共享任务；fork/clone 不接管原任务。恢复时已有完成记录可读，缺少最终记录的任务显示 `outcome_unknown`，绝不自动重放；重启不补发历史通知。
- **不是跨进程作业服务**：`/reload`、切换会话和退出会请求取消，停止旧通知。取消是协作式的，失去本地控制不能证明远端操作已结束。
- 后台任务原样保存完成完整原生结果钩子的 `Outcome.result`，另存权威 `Outcome.isError`，不改写保留结果。前台走同一完成路径，仅外部返回时投影权威错误位。后台句柄不进入原工具结果钩子，晚结果不补造 transcript 条目。partial updates 仍是原生进度更新，不能视为已被最终结果钩子脱敏；结束时清除暂存进度，结束任务预览和完成尾部只取最终结果。
- 扩展不二次清洗、截断或创建/删除原生输出文件。Pi 的 Bash / MCP 继续使用各自原生文本与输出路径，普通扩展工具遵循自身结果策略。索引保存最终文本及路径，不另设文本上限；单任务 `wait` 返回保留文本、结构化结果和完整原生 details（如 `truncation`、`fullOutputPath`）：原生 details 整体放在 `details.nativeDetails`，不展开进控制字段（数组/字符串原生 details 与其他任意 JSON 值同样保留），`details.task` 仍是 task 回执。图片、details 与结构化数据对普通任务仍仅在原进程内存保留，恢复后只有文本与任务元数据；CodeMode 所属任务的完整完成记录例外，见上节。读取回执不内联图片。
- 默认最多 4 个受管真实本地执行，保留最近 128 个已结束后台任务（待通知等记录暂受保护）；原生 CodeMode worker 另有不变的进程级上限 2。普通任务的后台晚到嵌套记录和 usage 不保证补进已完成父消息或 Pi 全局费用统计；CodeMode 所属任务按上节的关联记录/独立计费规则处理。
- `print/json` 模式下 `auto` 保持前台，`yes` 明确报错。已转后台后才出现的 MCP 交互仍是兼容边界；这类工具建议排除；`"no"` 只关闭计时转后台，不能防止用户主动转后台。

## 配置

读取全局 `~/.pi/agent/settings.json` 中的 `meantime` 字段（尊重 `PI_CODING_AGENT_DIR`）；不自动读取项目配置。修改后 `/reload` 生效。

```json
{
  "meantime": {
    "include": ["*"],
    "exclude": [],
    "autoDetachMs": 120000,
    "detachOnSteer": true,
    "maxRunning": 4
  }
}
```

`autoDetachMs: 0` 关闭计时转后台；`detachOnSteer: false` 只关闭 steer 触发。完整配置与约束见 [src/config.ts](src/config.ts)。

## 开发与验证

```sh
npm ci --ignore-scripts
npm run check       # 类型检查 + 测试
npm run test:pi     # 真实 Pi SDK 冒烟，脚本化 provider，无外部模型调用
node --experimental-strip-types scripts/sdk-codemode.mjs # CodeMode 离线 SDK 集成（也含在 npm test）
# 可选：验证已安装的 bundled Pi 宿主与 index.mjs 的 Jiti 模块身份
PI_TEST_SDK_MODULES=/path/to/pi/node_modules node --experimental-strip-types scripts/sdk-codemode.mjs
```

更多边界见 [设计说明](docs/DESIGN.md)，验证范围见 [验证说明](docs/VALIDATION.md)。[MIT License](LICENSE)。
