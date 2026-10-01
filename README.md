# GPT 网页版生图桥（gpt-web-image-bridge）

让本地 Agent（如 Codex）调用你已登录的网页版 ChatGPT 账号生成图片，无需付费 API。

> English: A bridge that lets local agents (Codex etc.) generate images through your logged-in ChatGPT web account instead of the paid API. It drives real Chrome with patchright, and exposes a CLI, an OpenAI-compatible HTTP API, and an MCP server.

## 简介

很多开发者的主力工具是本地 Agent，但图片生成额度在网页版 ChatGPT 账号里。本项目在两者之间搭桥：用 patchright（反检测补丁版 Playwright）驱动真实 Chrome 操作网页，把生图能力包装成本地接口。

核心特性：

- 提供三种调用方式：CLI、HTTP 常驻服务，以及 MCP 工具
- OpenAI 兼容接口，任何 OpenAI SDK 可直接接入
- 限额感知：自动解析恢复时间，排队等待重试，或返回 `retry_after` 供调用方决策
- 稳定自愈：掉线时弹窗等待人工重登并自动续跑，空闲时自动保活，残留浏览器进程自动清理
- 隔离对话：所有生图集中在一个 ChatGPT 项目里，不污染项目外的对话列表

## 快速上手

依次执行以下四条命令，即可完成首次配置并生成第一张图片：

```bash
npm install
node gptimg.js login       # 打开 Chrome 登录 ChatGPT，回终端按 Enter 保存会话
node gptimg.js setproject  # 自动抓取“生图”项目地址（需先在网页中建好该项目）
node gptimg.js gen "一只在月球表面弹吉他的猫，电影感"
```

成功后输出 JSON 结果，其中 `path` 字段是图片的本地路径：

```json
{"ok":true,"paths":["D:\\gptshengtu\\output\\xxx.png"],"path":"D:\\gptshengtu\\output\\xxx.png","elapsed_sec":62}
```

## 入门篇

### 安装与环境

运行本程序需要以下条件：

- Node.js 18 及以上版本
- 本机已安装 Google Chrome；未安装时回退到 Playwright 自带的 Chromium
- 可正常访问 chatgpt.com 的网络环境
- 一个 ChatGPT 账号，Plus 或 Pro 账号的生图额度更大

执行 `npm install` 安装依赖。依赖包含 patchright、playwright 和 MCP SDK，首次使用浏览器回退功能时需另行执行 `npx playwright install chromium`。

### 首次配置

**（1）登录账号**

执行 `node gptimg.js login` 后会弹出 Chrome 窗口。在窗口中登录 ChatGPT，并完成可能出现的人机验证。看到聊天输入框后，回到终端按 Enter，登录态会保存到 `.chrome-profile/` 目录。

**（2）配置生图项目**

临时聊天不支持生图，因此所有生图对话都收进一个专门的 ChatGPT 项目。请先在网页左侧栏的“项目”中新建一个名为“生图”的项目，再执行 `node gptimg.js setproject`，程序会自动抓取项目地址并写入 `config.json`。也可以复制项目页面地址，执行 `node gptimg.js setproject "项目地址"` 手动配置。

**（3）设置访问密钥（可选）**

常驻服务默认不带鉴权。仅在监听地址不是 127.0.0.1 时必须设置 API 密钥。执行 `node gptimg.js setapikey` 会生成随机密钥并写入 `config.json`。

**（4）验证**

执行 `node gptimg.js doctor`，确认登录态、浏览器驱动和项目配置均正常。

### 基本用法

最常用的方式是 CLI 直接调用，任何 Agent 都可以通过执行命令使用：

```bash
node gptimg.js gen "提示词"                              # 生成一张图片
node gptimg.js gen "提示词" --n 3 --ratio 16:9 --wait    # 批量 3 张，横图，限额时自动排队
node gptimg.js quota                                     # 查看最近 3 小时的生图数量
```

CLI 每次调用都要启动一次浏览器，耗时增加 10~20 秒，且窗口会短暂出现。高频使用建议改用常驻服务模式。

## 进阶篇

### 常驻 HTTP 服务

执行 `node gptimg.js serve` 启动常驻服务，默认监听 `127.0.0.1:3777`。浏览器保持打开，每个请求复用同一页面新建对话，响应速度最快。

设置了密钥后，生图类接口需要携带请求头 `Authorization: Bearer <密钥>`。健康检查和图片访问保持公开。密钥也可通过环境变量 `GPTIMG_API_KEY` 提供。

### OpenAI 兼容接口

服务提供 OpenAI 官方协议的生图接口 `POST /v1/images/generations`。支持 OpenAI SDK 的任何工具都可以直接接入，无需了解本项目的私有协议。

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:3777/v1", api_key="你的密钥")
result = client.images.generate(
    prompt="赛博朋克风格的重庆夜景",
    size="1024x1536",
    n=1,
)
print(result.data[0].url)  # 可直接访问的图片地址
```

### MCP 接入

MCP 适合 Codex、Claude 等原生支持工具调用的 Agent。以 Codex 为例，在配置文件 `~/.codex/config.toml` 中加入：

```toml
[mcp_servers.gpt-web-image]
command = "node"
args = ["D:\\gptshengtu\\mcp-server.js"]
```

重启 Codex 后即可自然语言调用，例如“生成一张猫咪的图片”。MCP 优先走已启动的常驻服务，服务未启动时自动退化为一次性 CLI 调用。为服务设置了密钥时，需要同步设置环境变量 `GPTIMG_API_KEY`。

### 限额与稳定性

网页版额度约为每 3 小时 50 张。触发限额时，常驻服务默认（`wait: true`）排队等待恢复后自动继续；设为 `wait: false` 时立即返回 HTTP 429，并附带 `retry_after` 秒数。

登录态会定期失效，属于正常现象。生图途中掉线时，程序会把浏览器窗口顶到最前方。你在 5 分钟内重新登录或完成人机验证后，程序自动继续刚才的任务，调用方无感知。常驻服务每 30 分钟自动刷新页面保活，掉线频率明显低于每次冷启动的 CLI 模式。

> 注意：在 Windows 终端用 `curl -d '{"prompt":"中文…"}'` 发送中文，提示词可能变成乱码，表现为模型回复无法识别而不生图。正确做法是把 JSON 写入 UTF-8 文件，再执行 `curl --data-binary @body.json`。通过 MCP 调用则不存在此问题。

## API 参考

### HTTP 接口

常驻服务提供的全部接口如下：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/generate` | 原生生图接口 |
| POST | `/v1/images/generations` | OpenAI 兼容生图接口 |
| GET | `/output/<文件名>` | 访问已生成的图片 |
| GET | `/health` | 服务状态、浏览器驱动与选择器能力探测 |
| GET | `/quota` | 最近 3 小时的生图数量 |
| GET | `/debug/pageinfo` | 排障用页面状态与截图，需要密钥 |

`POST /generate` 的请求体参数：

| 参数 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `prompt` | string | 必填 | 图片提示词，中英文均可 |
| `n` | number | 1 | 批量生成数量，范围 1~10，串行执行 |
| `aspect_ratio` | string | 无 | 宽高比，例如 `16:9`、`2:3`、`1:1` |
| `timeout` | number | 240 | 单张图片的超时秒数 |
| `wait` | boolean | true | 限额时是否排队等待恢复 |

`POST /v1/images/generations` 遵循 OpenAI 协议，接受 `prompt`、`size`、`n` 和 `response_format` 字段。`size` 的 `1024x1024`、`1536x1024`、`1024x1536` 分别映射为宽高比 `1:1`、`3:2` 和 `2:3`。

### CLI 命令

| 命令 | 作用 |
| --- | --- |
| `login` | 打开浏览器登录，保存会话 |
| `setproject` | 配置生图项目地址 |
| `setapikey` | 设置服务密钥，缺省时自动生成随机值 |
| `gen` | 生成图片 |
| `serve` | 启动常驻 HTTP 服务 |
| `quota` | 查看最近 3 小时的生图数量 |
| `doctor` | 检查登录态、浏览器驱动与项目配置 |

`gen` 命令支持的选项如下：

| 选项 | 说明 |
| --- | --- |
| `--n` | 批量生成数量，范围 1~10 |
| `--ratio` | 宽高比，例如 `16:9`、`2:3` |
| `--timeout` | 超时秒数，默认 240 |
| `--wait` | 触发限额时排队等待恢复 |
| `--out` | 输出文件名，仅 `n` 为 1 时生效 |
| `--headless` | 尝试无头模式 |

### MCP 工具

| 工具 | 作用 |
| --- | --- |
| `generate_image(prompt, aspect_ratio?, timeout_sec?)` | 生成图片，返回本地绝对路径 |
| `quota_info()` | 查询最近 3 小时的已用数量 |

## FAQ

**问：生图会把我的 ChatGPT 对话列表弄乱吗？**

答：不会。所有对话都发生在“生图”项目内部，侧边栏只多一个项目格子。

**问：提示未登录或被 Cloudflare 拦截怎么办？**

答：等待程序弹出的浏览器窗口，在窗口中重新登录或完成人机验证即可。也可以提前执行 `node gptimg.js login` 手动完成。

**问：触发限额后任务会失败吗？**

答：常驻服务默认排队等待恢复后自动继续。调用方传 `wait: false` 时会收到 HTTP 429 和 `retry_after` 秒数，可自行决定何时重试。

**问：生图超时了，哪里看现场？**

答：请求 `GET /debug/pageinfo`（需要密钥），返回当前页面地址、最后一条对话内容和大图数量，并在 `output/debug/` 保存页面截图。

**问：为什么 curl 发中文提示词会失败？**

答：Windows 终端的 curl 可能把命令行中的中文转为乱码。把 JSON 写入 UTF-8 文件后用 `--data-binary @body.json` 发送，或改用 MCP 调用。

**问：无头模式可以使用吗？**

答：可以，通过 `--headless` 开启。无头模式更容易触发人机验证，验证无法在无头窗口中完成，因此默认关闭。

**问：配置文件里有哪些敏感信息？**

答：`config.json` 存有项目地址和服务密钥，`.chrome-profile/` 存有登录 Cookie，两者均已加入 `.gitignore`。请勿将它们分享给他人。

## 附录

### 文件结构

```
gptimg.js           主程序，提供 login、setproject、setapikey、gen、serve、quota、doctor 命令
mcp-server.js       MCP 封装，提供 generate_image、quota_info 工具
config.json         项目地址与服务密钥，由命令自动生成，已加入 .gitignore
config.example.json 配置文件模板
output/             生成的图片、history.jsonl 记录和 debug/ 排障截图
.chrome-profile/    Chrome 登录会话，已加入 .gitignore
```

### 术语表

| 术语 | 说明 |
| --- | --- |
| CLI | Command Line Interface，命令行界面 |
| HTTP | HyperText Transfer Protocol，超文本传输协议 |
| API | Application Programming Interface，应用程序接口 |
| SDK | Software Development Kit，软件开发工具包 |
| MCP | Model Context Protocol，模型上下文协议 |
| JSON | JavaScript Object Notation，一种数据交换格式 |

### 更新日志

- `v0.2.0`：切换 patchright 驱动，新增 OpenAI 兼容接口和 API 密钥鉴权。同时新增限额排队等待、批量与比例参数、选择器多回退和排障端点
- `v0.1.0`：首个可用版本，提供 CLI、常驻服务和 MCP 三种调用方式

### 参考资料

- [gpt-web-gateway](https://github.com/stufently/gpt-web-gateway)：同类方案，本项目的多项设计参考自它
- [codex-chatgpt-web](https://github.com/miuuyy/codex-chatgpt-web)：把网页版 ChatGPT 变成 Codex 的原生模型
- [patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-node)：反检测补丁版 Playwright

### 许可与免责

本项目以 MIT 许可证发布。

通过浏览器自动化操作 ChatGPT 网页版可能违反 OpenAI 服务条款，存在账号被限制的风险。本项目仅供个人学习使用，请避免用于对外服务或商业用途，使用风险由使用者自行承担。
