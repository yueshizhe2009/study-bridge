# Study Bridge

把本地工作区暴露成一个 **MCP 执行层**，通过 **OpenAI 官方 tunnel** 接到网页版 ChatGPT —— 于是
ChatGPT（思考）→ 发起工具调用 → 本地执行 → 结果回给网页 → 网页继续想。

形态参考 ShunCode 的 Bridge 部分，但**只保留网页 tunnel 这一条链路**：不做自定义 API 接入、
不做 Codex 账号、不做聊天模型接入。对话在网页端进行，本地只负责「稳健地执行 + 让你看得见」。

## 为什么

- **省 token 钱**：把活从付费 API 挪到已有订阅的网页端
- **根治两类失败**：WebCodex 的 `unknown_project`（项目 id 间接层）与
  `long-tail tool not callable`（adaptive runtime 只暴露 133 个工具里的 26–55 个）。
  这里工具是**扁平直出 12 个**，工作区根是单一显式路径 —— 两类失败结构性消失
- **循环不被打断**：常驻监督 + 退避重启 + 断线重连；长任务跑在本地持久 PTY 里，跨 ChatGPT 回合存活

## 架构

```
ChatGPT 网页端
   ↓ OpenAI control plane（出站长连接，无公网端口）
tunnel-client  ← Electron 主进程 spawn
   ↓ --mcp.command 拉起（stdio）
hub/server.py  ← 12 个工具，Ask/Plan/Code 权限门控
   ↓ 每次 dispatch 追加 events.jsonl
Electron 活动面板（工具调用流 / diff / 终端 / 进度 / 状态）
```

## 目录

| 路径 | 内容 |
|---|---|
| `hub/` | Python MCP 执行层（server / hub / files / patch / proc / mode / events / progress） |
| `hub/tests/` | 42 个 unittest，覆盖内核、写入、事件、门控、协议分发 |
| `electron/` | 主进程（supervisor / events / chatview / settings）+ 渲染层 |
| `scripts/` | `mcp-probe.py`（本地探针）、`supervisor-smoke.js`、`events-smoke.js` |
| `docs/` | 工具对照表、WebCodex 治理记录 |

## 开发

```bash
npm install
npm test                  # 42 个 Python 测试
npm run probe             # 本地 MCP 探针（initialize/tools/list/tools/call）
npm start                 # 启动 Electron 应用
npm run build:linux       # AppImage + deb
```

## 常驻运行

隧道只在「应用运行时」或「`run-hub.js` 运行时」存在——关掉就断，ChatGPT 那边就调不动。两种方式：

**A. 用户级 systemd 单元（推荐，开机自启、崩了自拉起）**

```bash
systemctl --user enable --now study-bridge-hub.service   # 已装
systemctl --user status study-bridge-hub.service
journalctl --user -u study-bridge-hub.service -f
```

单元文件：`~/.config/systemd/user/study-bridge-hub.service`，跑的就是 `scripts/run-hub.js`。
加固取向与 `mcp-ro.service` 类似（`NoNewPrivileges` / `PrivateTmp` / `ProtectSystem=full`），
但**故意不限制 `ProtectHome`**——这个服务的职责就是读写用户的 vault。

**B. 无头前台运行（临时用）**

```bash
node ~/study-bridge/scripts/run-hub.js     # Ctrl-C 停止
```

**两者不要同时用**：应用会检测 `study-bridge-hub.service` 是否为 active，若在跑则显示
「tunnel: 已就绪 · systemd」并**拒绝再起第二个 client**（同一条 tunnel 上两个 client 会让
命令路由变得不确定）。所以单元运行时，应用里的启动按钮会变成「systemd 托管」且不可点。

## 用法

1. `npm start` → 点「启动」，状态栏显示 `tunnel: 已就绪` 并给出 URL
2. **让位**：如果 hub 与另一个 tunnel client（例如 WebCodex）共用同一条 tunnel，点「让位」
   停掉那个 client 的 service，避免两个 client 同时在线时命令路由不确定
3. 在 ChatGPT 的 `设置 → Connectors` 新建 connector 指向该 URL
4. 在应用内嵌的 chatgpt.com 里登录并对话；右侧活动面板实时显示工具调用

## 权限模式

`Ask`（只读）/ `Plan`（只读）/ `Code`（可写可执行）。模式只来自
`~/.config/study-bridge/mode`（由 app 开关写入），**没有任何工具接受 mode 参数**，模型无法自我提权。

## 状态与配置

- `~/.config/study-bridge/{settings.json,mode}` — 设置与模式
- `~/.local/state/study-bridge/{events.jsonl,patches/,sessions/,tunnel/}` — 事件、patch diff、会话日志、tunnel 运行态

凭据**不落盘**：沿用 `~/.config/webcodex/tunnel.env`（只读，从不写入），配置里用 `env:CONTROL_PLANE_API_KEY` 引用。

## 明确不做

不做页面注入/自动点击（跨回合全自动续跑需要注入，故不做）；不做自定义 API / Codex 接入；
不做 LSP（markdown 工作区无语言服务）；不暴露公网端口；不改动 WebCodex 三个 systemd unit 文件。
