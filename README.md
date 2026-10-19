# pi-meantime

让长时间工具调用转到后台，Pi 继续处理其他工作；完成后通知模型，不必反复查询。
纯 Pi 扩展，不修改核心，也不启动第二个 Agent。当前版本 **0.4.0**，面向 **Pi 1.3.0**，需要 **Node.js 22.19+**。

`bash` 原名可用；符合条件的 MCP / 扩展工具通过 `_mt` 代理调用，业务参数不变，只增加可选的 `__background__` 控制字段。未转后台时保持原生结果。

## 安装

任选一种来源，安装后在 Pi 中 `/reload`：

```sh
# Git
pi install git:github.com/astrosheep-zero/pi-meantime

# npm（需要该版本已发布；不可用时使用 Git）
pi install npm:pi-meantime@0.4.0
```

也可克隆后临时加载，不写入全局安装列表：

```sh
git clone https://github.com/astrosheep-zero/pi-meantime.git
cd pi-meantime
pi -e ./index.mjs
```

避免与其他覆盖 `bash` 的扩展同时加载。

## 人怎么用

正常让模型执行工具即可。默认从前台开始，运行超过 **120 秒**自动转后台；运行中发送 steer 输入或按 **Ctrl+Shift+B** 也可释放前台等待，不取消底层操作。`"no"` 只关闭计时转后台，不阻止这些用户操作或 `/meantime detach`；所有转后台仍须通过审批、调用进入和索引保存门槛。

| 命令 | 用途 |
|---|---|
| `/meantime` | TUI 打开实时任务面板；非 TUI 显示当前会话完整任务列表 |
| `/meantime detach` | 手动把允许转后台的前台调用转走；终端不支持快捷键时可用 |
| `/meantime cancel <id>` | 请求取消指定任务，不猜目标 |
| `/meantime rescan` | 重新扫描可代理工具 |
| `/bg` | `/meantime` 的别名，接受相同参数 |

面板运行中任务优先，其余按创建时间倒序；每秒及状态变化时刷新。
**↑/↓** 选择，**Enter** 展开/收起命令、已有进度、结束任务的输出尾部及输出路径，**c** 请求取消，**Esc/q** 关闭。
手动子命令反馈显示在 Latest background control 区域，只保留最近一次操作。

## 模型怎么用

以下是工具调用示例，不是终端命令。拿到任务 ID 就代表工作已启动，**不要重复执行原操作，也不要循环轮询**。

```js
bash({ command: "npm test", __background__: "yes" })

meantime({ action: "list" })
meantime({ action: "wait", id: "mt_1234abcd", timeout: 30 })
meantime({ action: "wait", id: "1234", timeout: 0 })
meantime({ action: "wait", ids: ["1234", "5678"], mode: "any", timeout: 60 })
meantime({ action: "cancel", id: "mt_1234abcd" })
```

ID 用实际返回值替换；支持唯一前缀，可省略 `mt_`，有歧义时报错。

| `__background__` | 行为 |
|---|---|
| `"auto"`（默认） | 从前台开始，允许计时、快捷键、steer 或 detach 命令转后台 |
| `"yes"` | 请求立即后台执行；等待原调用进入，当前 UI 审批期间延后 |
| `"no"` | 关闭自动转后台 |

控制字段在分派前移除。Bash 自身的 `timeout` 仍是命令硬超时，与转后台阈值无关。

`meantime` 只有三个动作：

- **list**：简短任务列表，默认 10 条；用 `offset`、`limit` 翻页，`limit` 最大 32。
- **wait**：等待结束或超时，返回当前状态或保留结果。`timeout` 单位为**秒**，默认 **30**，可用小数，无上限；**0** 立即返回。中止等待不取消任务。
- **cancel**：请求取消，不保证远端操作停止或副作用回滚；以工具最终结果为准。

`wait` 必须在 `id` 与 `ids` 中二选一。`ids` 接受 1–32 项，`mode: "all"`（默认）等全部结束，`"any"` 等任意一项结束；超时也会返回。批量回执含已结束结果及 `pending`，正文共享 32KiB 预算，被省略的结果可单独读取。

默认代理匹配 `mcp__*`，排除 IDE MCP；自定义工具可通过配置加入。代理继承原工具的 `direct` / `codemode` / `deferred` 可见性，不把间接工具提升为直连工具。MCP 默认 codemode 时，从 Codemode 调用对应 `_mt` 代理。顺序工具、不兼容的根 Schema 及保留字段冲突不会被强行包装。

## 完成通知、保存与边界

- 后台完成通知含任务 ID、状态、可选退出码、存在时的 `Output: <path>`，以及约 1KiB 的文本尾部。尾部标为不可信工具数据，不是指令，不含图片或结构化结果；需要更多信息时用单任务 `wait` 读取保留结果，或读取输出文件。
- Pi 忙碌或 UI 审批期间延后通知，空闲后重新筛选未读结果。期间被 `wait` 成功读取的结果会从待发通知中排除，避免重复完成唤醒；未取得结果的超时等待不算已读。通知可合并多项完成，已经入队的消息无法撤回，也不承诺崩溃场景下恰好投递一次。
- **Pi 1.3.0 已知缺口**：树导航取消/失败没有结束事件，期间积压的通知可能继续等待。任务仍保留 pending，可主动读取；下一次 agent settled、压缩结束等可用事件会重新尝试，不能保证无后续事件时自动补发。
- 任务索引及完成文本保存在 **Pi 会话自定义条目**中。同一会话的树导航共享任务；fork/clone 不接管原任务。恢复时已有完成记录可读，缺少最终记录的任务显示 `outcome_unknown`，绝不自动重放；重启不补发历史通知。
- **不是跨进程作业服务**：`/reload`、切换会话和退出会请求取消，停止旧通知。取消是协作式的，失去本地控制不能证明远端操作已结束。
- Bash 使用 Pi 原生有界文本和完整输出文件，扩展不另建或删除 Bash 文件。其他工具文本不超过 50KiB 时只存索引，更大时写私有 `.txt`，索引保留约 2000 字节预览及路径；文件默认最多保留 4MiB，超限会标记截断。图片与结构化数据仅在原进程内存保留，恢复后只有文本；读取回执不内联图片。
- 默认最多 4 个真实本地执行，保留最近 128 个已结束后台任务（待通知等记录暂受保护）。后台晚到 usage 可能未计入 Pi 全局费用统计。
- `print/json` 模式下 `auto` 保持前台，`yes` 明确报错。已转后台后才出现的 MCP 交互仍是兼容边界；这类工具建议排除；`"no"` 只关闭计时转后台，不能防止用户主动转后台。

## 配置

读取全局 `~/.pi/agent/meantime.json`（尊重 `PI_CODING_AGENT_DIR`），或用 `PI_MEANTIME_CONFIG` 指定绝对路径；不自动读取项目配置。

```json
{
  "autoDetachMs": 120000,
  "detachOnSteer": true,
  "include": ["mcp__*", "my_slow_tool"],
  "maxRunning": 4
}
```

`autoDetachMs: 0` 关闭计时转后台；`detachOnSteer: false` 只关闭 steer 触发。完整配置与约束见 [src/config.ts](src/config.ts)。

## 开发与验证

```sh
npm ci --ignore-scripts
npm run check       # 类型检查 + 测试
npm run test:pi     # 真实 Pi SDK 冒烟，脚本化 provider，无外部模型调用
```

更多边界见 [设计说明](docs/DESIGN.md)，验证范围见 [验证说明](docs/VALIDATION.md)。[MIT License](LICENSE)。
