# GPT 网页版生图桥（gpt-web-image-bridge）

让本地 agent（Codex 等）通过**网页版 ChatGPT** 生成图片。用你的真实 Chrome + 一次人工登录，之后 agent 即可通过 CLI / HTTP / MCP 三种方式调用生图。图片保存在 `output/` 下。

> **English**: Bridge that lets local agents (Codex etc.) generate images through your **logged-in ChatGPT web account** instead of the paid API. Drives real Chrome with [patchright](https://github.com/nichochar/patchright-js-node), exposes a CLI, an OpenAI-compatible HTTP API (`/v1/images/generations`) and an MCP server. Features: auto re-login prompts, quota-aware retry with `Retry-After`, batch generation, aspect-ratio control, API-key auth.

> ⚠️ **免责声明**：本项目通过浏览器自动化操作 ChatGPT 网页版，可能违反 OpenAI 服务条款，存在账号被限制的风险，仅供个人学习使用，不要用于对外服务或商业用途。使用即视为自担风险。

## 快速开始

```bash
npm install
node gptimg.js login       # 第一次：打开 Chrome，登录 ChatGPT，回车后保存会话
node gptimg.js setproject  # 第一次：自动抓取"生图"项目的地址（需先在网页里建好该项目）
node gptimg.js doctor      # 验证登录态与项目配置是否正常
node gptimg.js gen "一只在月球表面弹吉他的猫，电影感"
```

**关于"生图"项目**：临时聊天不支持生图，所以所有生图对话都收进一个叫「生图」的 ChatGPT 项目里——项目在侧边栏只占一个格子，项目外的对话完全不受影响。请先在 chatgpt.com 左侧栏"项目"中新建名为「生图」的项目，再运行 `setproject` 自动抓取地址；也可以打开项目页复制 URL，运行 `node gptimg.js setproject "<项目URL>"`。

成功后 stdout 输出：`{"ok":true,"path":"D:\\gptshengtu\\output\\xxx.png","elapsed_sec":87}`

## 三种调用方式

### 1. CLI（任何 agent 都能用）

```bash
node D:\gptshengtu\gptimg.js gen "提示词" --timeout 240 --out demo.png
node D:\gptshengtu\gptimg.js gen "提示词" --n 3 --ratio 16:9 --wait   # 批量3张 / 横图 / 限额时自动排队
node D:\gptshengtu\gptimg.js quota   # 最近 3 小时已生成多少张
```
注意：每次调用都要启动一次浏览器（慢 10~20 秒），且窗口会闪现。高频使用建议用 serve 模式。

### 2. HTTP 常驻服务（推荐，最快）

```bash
node gptimg.js serve --port 3777
node gptimg.js setapikey   # 可选：生成随机 API Key 存入 config.json（监听非 localhost 时务必设置）
```
浏览器保持打开，每次请求直接复用页面新建对话。接口一览：

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/generate` | `{"prompt":"...","n":2,"aspect_ratio":"16:9","wait":true}` 原生接口 |
| POST | `/v1/images/generations` | **OpenAI 兼容接口**（`prompt` / `size` / `n` / `response_format`），任何 OpenAI SDK 直接可用 |
| GET | `/output/<文件名>` | 生成图片的 HTTP 访问（OpenAI 接口返回的 url 就是它） |
| GET | `/health` | 服务状态 + 页面选择器能力探测 |
| GET | `/quota` | 最近 3 小时已生成数量 |
| GET | `/debug/pageinfo` | 排障：当前页面状态 + 截图（需 API Key） |

设置了 API Key 后，生图类接口需带请求头 `Authorization: Bearer <key>`。

**限额语义**：触发限额时，默认（`wait:true`）服务端排队等待恢复后自动继续；`wait:false` 则立即返回 HTTP 429 并带 `retry_after` 秒数。

> ⚠️ **Windows curl 中文乱码坑**：在 Git Bash / PowerShell 用 `curl -d '{"prompt":"中文..."}'` 发送中文可能变乱码（模型收到乱码就不生图，表现为超时）。正确做法：把 JSON 写入 UTF-8 文件再 `curl --data-binary @body.json`。给 agent 的提示词里应写明这一点，或直接让 agent 用 MCP。

### 2b. OpenAI SDK 调用示例

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:3777/v1", api_key="<你的key>")  # 未设key可填任意值
r = client.images.generate(prompt="赛博朋克风格的重庆夜景", size="1024x1536", n=1)
print(r.data[0].url)  # http://127.0.0.1:3777/output/xxx.png
```

### 3. MCP（Codex / Claude 等按 tool 调用）

在 Codex 的 `~/.codex/config.toml` 中加入（Windows 路径注意转义）：

```toml
[mcp_servers.gpt-web-image]
command = "node"
args = ["D:\\gptshengtu\\mcp-server.js"]
```

工具：
- `generate_image(prompt, aspect_ratio?, timeout_sec?)` → 返回图片本地绝对路径
- `quota_info()` → 最近 3 小时已用数量

配合 serve 模式使用体验最佳（先另开一个终端跑 `node gptimg.js serve`，MCP 会自动优先走 HTTP）。

## 常见问题

- **掉线 / 提示 NOT_LOGGED_IN**：网页会话会定期失效，属正常现象。程序已内置恢复机制：生图途中掉线会自动把浏览器窗口顶出来，你重新登录或点一下人机验证（5 分钟内），程序检测到后**自动继续刚才的生图**，agent 侧无感知。serve 模式每 30 分钟自动保活，掉线频率比每次都启动浏览器的 `gen` 模式低很多，推荐日常使用 serve。
- **被 Cloudflare 拦截**：同上的弹窗重登流程即可；也可以手动运行 `node gptimg.js login` 预先过验证。
- **限额**：网页版约每 3 小时 50 张。serve 默认识别限额文案（含"X 点后恢复"的时间）并排队等待自动重试；不等则返回 429 + `retry_after`。`quota` 命令可看本程序记录的使用量。
- **反检测**：v0.2 起默认使用 [patchright](https://github.com/nichochar/patchright-js-node)（反检测补丁版 Playwright）驱动真实 Chrome，多选择器 fallback（中英文 UI 文案）降低前端改版失效概率。
- **失败排查**：先看 `node gptimg.js doctor` 输出；ChatGPT 前端改版可能导致选择器失效，需更新 `gptimg.js` 顶部的选择器常量。
- **无头模式**：`--headless` 容易触发验证，默认关闭，需要时自行尝试。
- **会污染我的对话列表吗**：不会。所有生图都发生在你配置的「生图」项目里，侧边栏只多一个项目格子，项目外的对话不受影响。注意：临时聊天不支持生图，所以不采用临时聊天方案。
- **隐私**：`.chrome-profile/` 内有你的登录 Cookie，不要提交到 git，也不要分享给他人。

## 文件结构

```
gptimg.js           主程序（login / setproject / setapikey / gen / serve / quota / doctor）
mcp-server.js       MCP 封装（generate_image / quota_info）
config.json         "生图"项目的 URL + API Key（命令自动生成；已 gitignore，参考 config.example.json）
output/             生成的图片 + history.jsonl 生图记录 + debug/ 排障截图
.chrome-profile/    Chrome 登录会话（勿外泄，已 gitignore）
```
