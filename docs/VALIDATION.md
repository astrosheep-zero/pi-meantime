# 验证与复跑

固定开发基线：Pi/SDK 1.3.0，锁文件固定依赖；当前开发版在 Node 26.10.0 验证。仓库只保留代码和可复跑 fixture，不包含运行日志、私有环境路径、auth、生成会话或原始验收证据。

## 当前开发版已验证范围

- 正式 SDK 类型检查和单元/组件测试通过，覆盖前台不落盘、后台晋升、晚结果、owner 隔离、结果清理失败后恢复重试。
- 无模型调用的真实 SDK smoke：原生 Bash、本地 MCP、后台结果嵌套读取；使用磁盘 SessionManager，确认前台无扩展文件/索引，重开会话文件并重新加载扩展后读回 completion 文本。小 Bash 无文件，超大 Bash 引用 Pi 原生文件，超大扩展工具文本只写一个 `.txt`；恢复保留路径及预览，图片/结构化数据不持久化。
- 官方 SDK 结果钩子、取消和权限检查通过；选择器由测试适配器提供，不代表真实终端菜单验收。

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
npm run test:pi
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

未测试真实远端HTTP/SSE MCP及其认证/elicitation、小时/天级长跑、断电/fsync耐久、跨进程并发写事务、所有终端尺寸/主题或所有第三方RPC客户端。取消沿用原生语义，不保证远端回滚副作用。权限屏障覆盖提示结果后立即结算的钩子路径，不为任意插件追加的长期异步裁决作保证。最近操作面板是快照，后台结算后可用 /meantime status 刷新。
