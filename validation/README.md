# v0.1.4 全套复跑

需要 Node 22.19+（本次24.19.0）、Python3、真实PTY和localhost TCP。固定官方Pi/SDK1.3.0；无tmux、真实凭据或付费provider。

```sh
npm ci --ignore-scripts
bash validation/run-all.sh /path/to/new-empty-output
PI_E2E_NODE="$(command -v node)" python3 e2e-restart/run-restart.py proof-new
python3 e2e-restart/verify-restart.py proof-new
```

脚本拒绝覆盖现有输出。prepare将生产文件复制到5个隔离工作区；只复用本源码的锁定node_modules。每个Pi都是空HOME/agent目录、offline、显式本地mock provider和开发fixture。HTTP mock与Pi启动在同一launcher进程树。运行目录中的session/auth配置都是合成测试资料；交付证据仍主动排除这类目录。

- original：17个真实CLI/PTY场景及retention回归，先做正式SDK类型、87单测和headless SDK smoke
- lifecycle：14个真实会话往返/fork/tree/steer/取消边界场景
- cancel：9个原生、bg、no调用×合作/晚成功/晚错误配对
- manual：6个手动取消/误ID/已完成幂等/跨会话/auto与no三次steer场景
- permissions：6个真实Pi选择菜单的yes/auto×允许/拒绝/Escape
- scripts/sdk-cancel-permissions.mjs：10项真实SDK最终结果钩子和权限路径；此层UI是测试适配器，不能代替permissions真实菜单证据
- e2e-restart：实际SIGKILL后官方--session恢复，仅验证已写盘快照、无业务重放，不声称断电持久性

证据断言读取真实host events、实际HTTP tool calls、MCP wire和磁盘；mock回复里的“OK”不作为成功依据。发/reload前要等真实agent_settled，Pi在模型仍答复时会明确提示等待，不能把这个提示误算作完成了reload。过早发命令只会触发原生busy提示，不能计为成功reload。仓库不包含原始测试日志或生成的会话。
