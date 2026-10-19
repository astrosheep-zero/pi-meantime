# 验证与复跑

固定开发基线：Pi/SDK 1.3.0，锁文件固定依赖；当前开发版在 Node 26.10.0 验证。仓库只保留代码和可复跑 fixture，不包含运行日志、私有环境路径、auth、生成会话或原始验收证据。

## 当前开发版已验证范围

- 正式 SDK 类型检查和单元/组件测试通过，覆盖前台透明返回、后台保留原生结果对象及 block 顺序/控制字符、原生路径恢复与淘汰不删文件、晚结果与 owner 隔离、索引失败。
- 无外部模型调用的真实 SDK smoke：先用**不安装 meantime 的独立 AgentSession** 调本地 MCP 大文本，检查原生结果及 session JSONL；再通过后台代理调同一 MCP 工具，确认 wait 文本除原生随机路径外与基线完全相同、路径是原生 details.fullOutputPath、structuredContent 保留全文/控制字符，另测原生 MCP 错误结果。原生 Bash 仍引用 Pi 文件；公开 wait 的 details.fullOutputPath 对 Bash 和 MCP 都保留，并验证 Bash truncation 与 MCP 原生 details。磁盘 SessionManager 的 completion index 保存原生文本/路径，重开会话并重载扩展后完整读回该文本与路径；任务索引不另加大小上限，恢复仍是 text-only。
- 先决证据：真实本地 MCP 返回 60,018 字节，原工具和代理收到的模型文本均为 20,707 字节，含原生 `Warning: truncated output`、`details.fullOutputPath`，文件及 structuredContent 保留全文；ANSI/NUL 在原生模型文本中保留。持久化核对 Pi 1.3.0 agent-core 的 `createToolResultMessage`：历史消息保留 content/details，不包含 structuredContent；coding-agent 的 `dist/core/agent-session.js` message_end → `SessionManager.appendMessage`，以及 `dist/core/session-manager.js` `_persist` / `_rewriteFile` 将该消息直接 JSON 序列化，没有二次文本截断；smoke 读回实际原生工具结果 JSONL，验证文本与路径相同、structuredContent 未持久化。没有用理想化的输出上限替代真实宿主行为。
- `no` 只关闭计时转后台：runtime/适配器回归覆盖 steer、快捷键、`/meantime detach`，以及审批拒绝、调用进入、索引失败和 print/json admission 门槛；模型控制语义集中在共享 system prompt，代理只保留原工具名与控制字段提示，Schema 仅验证可选的 `auto|yes|no` 枚举。不代表真实终端快捷键验收。
- `npm run check` 覆盖单个/批量 wait 的折叠及展开正文预览；`node scripts/pi-smoke.mjs` 覆盖批量 wait 的原生 structuredContent/文本结果，并检查控制说明字符数、共享 prompt 语义及 codemode-only/deferred 代理的发现与调用。
- 用户 detach 的 runtime/适配器回归覆盖 steer、Ctrl+Shift+B 与 `/meantime detach` 提前结束单任务 wait；同一 detach 释放并发的批量 wait 和取消宽限期 wait，返回超时形状的当前结果/未完成快照，未完成任务随后各通知一次。另测完成结果保留、waiter 保护释放后的正常淘汰、后续 wait 不继承 detach、`detachOnSteer=false`，既有完成/超时/Esc abort 路径继续覆盖；快捷键与输入事件由测试适配器触发，不代表真实终端按键或 steer 排队验收。
- 官方 SDK 结果钩子、取消和权限检查通过；选择器由测试适配器提供，不代表真实终端菜单验收。
- 模型取消（含真实 SDK Codemode）复用单任务 wait：宽限期内落定返回原生结果并标记 observed，宽限期超时或调用中断后仍保留结束通知；TUI 命令和面板取消保留通知，取消后的终态为 cancelled，原生错误及远端副作用语义不变。
- `node scripts/pi-smoke.mjs` 的 `EARLY_STEER` 使用真实 AgentSession、脚本化 provider 和真正的 Codemode/QuickJS worker（无外部模型请求）。覆盖外层代理审批前 steer（`no` 模式批准后仍响应用户 steer；拒绝不执行）、Codemode 尚无 managed task 时的 steer、公开 execution-start 精确 admission 边界、已有 producer 的 steer、`detachOnSteer=false`。批准前没有业务执行/句柄；拒绝不运行 producer；批准后句柄出现时 producer 仍被 gate 持有、后续独立完成且 signal 未取消。每例证明 steer 文本进入下一 provider context、下一模型回合的无关 held task 仍在前台；拒绝例再关闭旧会话、重载资源并绑定新的 AgentSession，复用 call ID，证明新会话无旧意图。日志打印调用/父 ID、任务数、审批、执行、句柄和模型请求顺序；不把真实 RPC-mode SDK 当作 RPC transport 或 TUI 验收。

## 0.1.4 历史验证

以下为旧版本范围，尚未对当前存储格式重跑；旧验收脚本可能仍依赖旧任务格式：

- 正式 SDK 类型契约及87项单元/组件测试通过
- 无真实模型调用的SDK smoke通过
- 52个真实CLI/PTY场景通过：原有后台行为17、会话/竞态14、MCP取消配对9、手动取消/steer6、真实审批菜单6
- 10项官方SDK结果钩子/权限检查通过；该层选择器是测试适配器，与真实菜单测试分开
- 实际进程SIGKILL后，官方同会话恢复34项断言通过；无业务重放，已完成结果保留
- 另做真实RPC传输3场景、89断言：手动命令、取消、完成消息与前台abort；这不代表第三方客户端已渲染UI

## 本地运行

```sh
npm ci --ignore-scripts
npm run check
npm run demo
npm run test:pi     # 等价于 node scripts/pi-smoke.mjs
node --experimental-strip-types scripts/sdk-cancel-permissions.mjs
```

旧版本完整宿主验收入口（当前存储格式未复验）：

```sh
bash validation/run-all.sh /path/to/new-empty-output
PI_E2E_NODE="$(command -v node)" python3 e2e-restart/run-restart.py proof-new
python3 e2e-restart/verify-restart.py proof-new
```

真实PTY套件使用Python3、localhost TCP和官方Pi CLI。每例隔离HOME/agent目录，仅使用本地HTTP模型mock和MCP stdio fixture，不需要真实API key。脚本拒绝覆盖已有证据。可选屏幕重建使用Pillow/wcwidth，仅把原始ANSI还原为终端字符图，不是图形桌面截图。RPC增量验证不在当前52场景脚本内。

## 边界

未测试真实远端HTTP/SSE MCP及其认证/elicitation、小时/天级长跑、断电/fsync耐久、跨进程并发写事务、所有终端尺寸/主题或所有第三方RPC客户端。取消沿用原生语义，不保证远端回滚副作用。权限屏障覆盖提示结果后立即结算的钩子路径，不为任意插件追加的长期异步裁决作保证。最近操作面板是快照，后台结算后可用 /meantime 刷新。
