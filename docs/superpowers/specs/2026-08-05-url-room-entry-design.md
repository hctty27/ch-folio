# URL 房间入口设计

## 目标

让前端地址本身决定是否启用多人模式：

- `https://ch.testnb.me/`：严格单人模式，不建立多人 WebSocket。
- `https://ch.testnb.me/?room=abc123`：加入 `abc123` 房间。
- 只有规范化后房间名完全相同的客户端才互相同步。

## 地址与房间规则

前端使用 `URLSearchParams` 读取第一个 `room` 参数。

有效房间名必须满足：

- 去除首尾空格后长度为 1–64 个字符。
- 仅包含 ASCII 小写字母、数字、连字符 `-` 和下划线 `_`。
- 输入统一转为小写，因此 `?room=ABC` 与 `?room=abc` 是同一房间。

以下情况按单人模式处理，不发起多人连接：

- 没有 `room` 参数。
- `?room=`。
- 房间名只包含空格。
- 房间名包含中文、空格、斜杠或其他不允许字符。
- 房间名超过 64 个字符。

其他查询参数不影响该规则，例如 `/?foo=1` 仍是单人模式。

## 前端结构

新增一个纯函数模块负责解析地址中的房间名，使规则可独立测试：

```js
resolveRoomFromSearch(search: string): string | null
```

应用启动流程只在以下条件全部满足时调用多人模块：

1. `VITE_MULTIPLAYER_ENABLED` 为 `1` 或 `true`。
2. `VITE_SERVER_URL` 存在。
3. `resolveRoomFromSearch(window.location.search)` 返回有效房间名。

`Multiplayer.start()` 改为显式接收房间：

```js
multiplayer.start({ room })
```

不再从 `VITE_MULTIPLAYER_ROOM` 读取默认房间，避免普通访问意外进入公共大厅。

## 后端数据流

Worker 已读取 `/ws?room=<name>`，并通过：

```ts
env.GAME_ROOM.getByName(room)
```

把相同房间名路由到同一个 Durable Object。此次不修改 Worker 协议或 Durable Object 实现。

## 错误处理

无效或缺失房间参数不显示错误，也不连接服务器，页面继续以单人模式运行。这样分享普通首页链接不会产生多人流量；只有明确分享带 `room` 的邀请链接才进入多人模式。

## 测试

新增测试覆盖：

- 无参数、空参数和无关参数返回 `null`。
- 合法房间名被去空格并转小写。
- 非法字符和超长房间名返回 `null`。
- 应用入口只在得到有效房间名时启动多人。
- `Multiplayer` 使用调用者传入的房间，不再引用 `VITE_MULTIPLAYER_ROOM`。

完整验证继续运行根目录测试、Vite 生产构建、Worker 测试和 Worker 类型检查。
