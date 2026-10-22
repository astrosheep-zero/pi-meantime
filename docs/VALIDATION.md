# 验证与复跑

目标宿主 / SDK：**Pi 1.3.0**。本页说明验证方法与边界，不保存交付回执、测试运行日志或历史验收结论。

## 本地入口

```sh
npm ci --ignore-scripts
npm run check
node scripts/pi-smoke.mjs
node --experimental-strip-types scripts/sdk-cancel-permissions.mjs
```

`npm run check` 负责类型检查及单元/组件回归；SDK 脚本使用真实 AgentSession 和本地脚本化 provider，不需要外部模型调用。是否通过应以当前源码实际运行结果为准，不能从本文推断。

## 关键检查

| 层次 | 应检查的行为 |
|---|---|
| Schema / adapter | 可选控制字段在原 preparer 前移除；原生描述、元数据和 exposure 保留；不兼容、隐藏及顺序工具不接管；同步 refresh → reconcile → 必要时第二次 refresh 更新实际获胜定义，无轮询；dispose 不覆盖第三方修改 |
| 原生管线对照 | 独立的无扩展 session 与受管同名调用对照；准备/校验/全部权限各一次，拒绝不 admission、不执行；权限修改参数后不重复验证 |
| 完成边界 | 原 execute、完整结果钩子与图片处理各一次；原 name / ID / parent 保留；后注册权限 handler 的 denial/mutation 不被绕过；真实 Agent core start-before-prepare 路径、primitive JSON repair、对象 fence 的重叠同 ID 隔离；最终 Outcome.result 原样保存，权威 Outcome.isError 独立保留，前台返回与 wait 回执正确投影；content、details、structuredContent 脱敏进入保留结果及通知尾部；句柄不进入原钩子，admission 失败不跳过原生完成路径 |
| 真实 SDK 发现与调用 | builtin Codemode 的描述、ALL_TOOLS、searchTools 及独立 tool_search 只有原名候选；Bash、MCP、扩展工具均走同一路径；无 outputSchema 的工具也能从 Codemode 取得后台句柄 |
| runtime / 取消 | auto、yes、no、提前 steer、快捷键/命令 detach、单/批量 wait、通知已读竞态、审批和索引失败；父取消与 detach 后 job 取消隔离；原生抛错和取消按最终 Outcome 分类 |
| 通知交接 | 任务完成/句柄发布两种先后；活动工具批次结束时 debounce 未到也应交接；审批 continuation 完成后下一请求可见；默认 steeringMode 下 17 个 eligible 任务分成每条最多 16 个的全部批次并进入同一请求；交接前原子 queued，公开 message_end 确认消费，queued 保留；Stop 清队列不丢已暂存通知、不自动复活；空闲准备失败只回退未消费项，下一合法请求恢复；busy 恢复、已读/waiter 抑制保持语义 |
| 生命周期 / 保存 | 重注册、撤回/恢复、MCP 迟到、reload / session 替换；dispose 撤销代次，身份/liveness 检查阻止旧 finalizer 和嵌套分派进入新 runner/runtime；批准后取消且未 execute 的对象 frame 随 validated args 弱键回收；primitive fallback 由 after/end 清理，最终 shutdown 后的晚到 no-after 标记待 session GC；恢复 text-only、缺结果为 outcome_unknown、不重放、不删除原生文件；晚到 producer 不提前释放本地配额 |

测试应对照**不安装扩展时的同一个工具**，不能以 fake host 代替原生结果语义。单测、真实 SDK 与真实终端分层报告，不以一层通过代替另一层。

## 未覆盖与宿主限制

本轮**不声称完成真实 TUI 验证**。测试触发 input / shortcut、模拟选择器或 RPC-mode SDK 不等于真实终端按键、steer 排队、权限菜单或 RPC transport 验收。

真实远端 HTTP/SSE MCP、认证与晚到 elicitation、小时/天级长跑、断电/fsync、跨进程并发写入，以及全部终端/第三方客户端不在此页承诺范围。取消沿用原生协作语义，不保证远端回滚；partial updates 不保证经过最终结果钩子脱敏；晚到 nested bookkeeping / usage 不保证回填已完成父消息及全局统计。

Pi 1.3.0 树导航取消/失败没有结束事件。验证应区分“pending 结果仍可读、后续事件可重试通知”与“无需后续事件自动补发”；后者不受保证。`pi-smoke.mjs` 验证积压通知进入恢复 run 的首个请求，不能等恢复 run 结束后另起通知轮。详见 [设计说明](DESIGN.md)。
