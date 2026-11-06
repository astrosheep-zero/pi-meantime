# 验证与复跑

完整检查使用锁定的原版 **Pi 1.3.0 SDK**；通知集成另覆盖已安装的原版 **Pi 1.5.0 SDK**。不修改 Pi、不注入 Agent 方法、不混用其他版本 Agent 源码。本页说明方法和边界，不保存交付回执或历史验收结论。

## 本地入口

已有依赖时直接运行，无需安装或构建：

```sh
npm run check
node --experimental-strip-types --test test/notifications-sdk.test.ts
```

`npm run check` 包括类型检查、单元/组件回归、真实 SDK 通知及 CodeMode 集成。SDK 使用本地脚本化 provider，无外部模型请求。`scripts/sdk-codemode.mjs` 的精确 usage 与容量预期对应锁定的 1.3.0，不把较新宿主的 usage 字段/FIFO 行为混进 pinned 检查；1.5.0 的独立证据只覆盖通知集成。

验证另一个原版安装的通知集成时，可在 `/tmp` 创建一个仅重定向 vendor 模块来源的 Node preload。它选择安装目录内完整的一套 SDK/Agent/AI，不补造方法或改写宿主：

```sh
cat > /tmp/meantime-stock-sdk-loader.mjs <<'EOF'
import { registerHooks } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const parentURL = pathToFileURL(resolve(process.env.PI_TEST_HOST_MODULES,
  '@earendil-works/pi-coding-agent/__meantime-check__.mjs')).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(specifier, specifier.startsWith('@earendil-works/')
    ? { ...context, parentURL } : context);
}});
EOF
PI_TEST_HOST_MODULES=/path/to/stock/pi/node_modules \
node --import /tmp/meantime-stock-sdk-loader.mjs --experimental-strip-types --test test/notifications-sdk.test.ts
```

复跑时移除旧源码 resolver 的 `NODE_OPTIONS`。不能用 patched core、队列方法 shim 或混合源码通过冒充原版 SDK 通过。

## 关键检查

| 层次 | 应检查的行为 |
|---|---|
| Schema / adapter | 原名与元数据保留；控制字段在原 preparer 前剥离；权限完整一次，拒绝不启动 producer；refresh 同步 reconcile；dispose 按归属恢复 |
| CodeMode | 只包装真实 builtin execute，不重复注册；carrier/fence/scope 保留；脚本局部状态与正常 finally 连续执行，不重放；显式后台子任务独立；完成关联记录、lateScope、JSON 序列化及 usage 不重计；原版 pinned SDK 的原生容量/取消/reload 回归 |
| runtime / 取消 | auto/yes/no、三秒用户 steer、快捷键和 detach；通知不触发 detach、不释放其他任务 wait；取消 observer 不取消 producer；错误按最终 Outcome 裁决 |
| busy / idle 通知 | busy completion 保留 pending，不移入宿主 steering；公开边界交接每批最多16项，17项最终全部到达；已空闲完成主动发送 triggerTurn:true，无需其他事件；审批 continuation 与压缩结束后恢复推进 |
| wait 交接前抑制 | 单项/批量成功 wait 抑制尚未交接结果；活跃 waiter 暂停通知；timeout 返回的已有结果被 observed，未返回的结果在 waiter 释放后重新推进；abort 不假装读取、不取消 producer |
| 失败 / Stop / 清理 | 真实准备拒绝（gated beforeStart + abort + invalid section）只降级 append-only，不再次 wake；250ms/1000ms 有限退避且其他回调不绕过；耗尽失败可见、完整结果保留并保护免裁剪，后批能推进；Stop 取消 retry 并禁止复活，cleanup 取消 generation timers；已消费后 Promise 晚拒绝不重投，也不抑制后续普通 idle 唤起 |
| 保存 / 生命周期 | 仅真实 message_end 确认消费，消息保存后才持久化 delivered，未落盘回执保留保护；原版真实会话重开不重投已消费消息；session/reload 代次隔离，真实副作用不自动重放；已有工具/CodeMode adapter 的生命周期回归继续通过 |

测试对照**不安装扩展时的同一个工具**，不能以 FakePi 代替原生结果语义。通知失败故障注入位于公开 send 边界，另有真实 SDK 准备失败回归；不注入队列能力或构造假的 delivered 回执。跨批不保证 FIFO，测试只钉实际契约。

## 未覆盖与宿主限制

允许通知等到较晚安全边界，不承诺紧邻请求看到；交给宿主后不能撤回，接受 handoff/wait 的窄重复竞态，不承诺崩溃恰好一次。准备失败未必发出公开取消事件，故统一降级为 append-only 重试；下一次明确用户回合才恢复主动唤起。公开 Stop settled 事件额外取消 retry，准备阶段不可见取消不靠私有字段或错误文本猜测。

不声称完成真实 TUI 按键、RPC transport、远端 HTTP/SSE MCP、认证/晚到 elicitation、小时/天级长跑、断电/fsync 或跨进程并发写入验收。取消沿用原生协作语义，不保证远端回滚；partial updates 不保证经过最终结果钩子脱敏；普通任务晚到 nested bookkeeping / usage 不保证回填旧 transcript。

Pi 1.3.0 树导航取消/失败没有结束事件，可能需等待后续可用事件恢复通知；任务仍可主动 wait 读取。`scripts/pi-smoke.mjs` 与 `scripts/sdk-cancel-permissions.mjs` 是额外的 pinned SDK harness，不等于真实终端验收。主通知契约以当前 `test/notifications-sdk.test.ts` 为准。
