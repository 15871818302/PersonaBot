# 个人 QQ 助手

LLBot 登录机器人小号并提供 Satori 服务。Koishi 接收指令，直接调用所选 AI、天气或快递服务。可以先只开天气，再分别配置 AI 和快递。业务指令默认仅向白名单开放；`ping` 可用于检查连接。

| 在 QQ 中发送 | 行为 |
| --- | --- |
| `聊天 你好` 或 `ai 你好` | 对当前用户的文字问题使用服务器指定的模型和角色 |
| `忘记聊天` | 清除当前用户在当前会话中的本地聊天历史 |
| `天气 杭州` | 查询中国城市的当前气温、湿度、天气状况和北京时间 |
| `快递 韵达 运单号` | 仅限授权私聊，返回单号末四位、状态和最新记录时间 |
| `ping` | 回复 `pong` |

## 本地开发与小号接入

在本项目目录运行。已安装依赖的环境可跳过第一行。首次创建密钥文件时使用 `install`；已有文件时直接编辑，避免覆盖。

```bash
corepack yarn install --immutable
test -e .env.local || install -m 600 .env.example .env.local
npm run dev
```

控制台只监听本地回环地址，默认端口 5140。从控制台进入沙盒，先发送 `ping`。要在沙盒测试业务命令，把当前沙盒的平台和用户 ID 写入 `BOT_ALLOWED_USERS`，修改环境后重启。沙盒和真实 QQ 分别授权。

1. 按 LLBot 官方安装向导启动接入层并扫码登录**机器人小号**。在 LLBot 启用 Satori，指定端口（例如 5600）及随机 token。宿主机部署 Koishi 时，将 Docker 中的 Satori 和 WebUI 端口仅发布到 `127.0.0.1`。跨机器联调用 SSH 隧道。[LLBot 安装](https://luckylillia.com/guide/choice_install) · [LLBot 对接 Koishi](https://luckylillia.com/guide/install_koishi)
2. 在 Koishi 的 `.env.local` 设置 `SATORI_ENDPOINT=http://127.0.0.1:5600` 和对应的 `SATORI_TOKEN`。当前 LLBot 的 Satori 平台标识是 `llonebot`。例如主号为 123456789 时，填 `BOT_ALLOWED_USERS=llonebot:123456789`。这里填**发送指令的人**。群聊还需 `BOT_ALLOWED_GROUPS=llonebot:群号`，多个 ID 用英文逗号分隔。其他接入版本按其实际平台标识填写。[LLBot 登录信息实现](https://github.com/LLOneBot/LuckyLilliaBot/blob/main/src/satori/api/login/get.ts)
3. 重启后，用主号私聊小号发送 `ping`、`天气 杭州`。群里按 Koishi 配置使用指令前缀或 @小号。每条业务指令都核对用户身份；快递在群聊中始终拒绝。普通消息不会自动发往模型。

## 模型与酒馆角色

在服务器或本地私有环境文件里填写 `AI_PROVIDER`、`AI_MODEL` 和所选服务的密钥。模型 ID 从自己账号可用的模型列表复制；OpenAI 和 xAI 使用支持 Responses API 的文本模型。切换模型后重启进程。

| AI_PROVIDER | 密钥变量 | 接口 |
| --- | --- | --- |
| `gemini` | `GEMINI_API_KEY` | [Google generateContent](https://ai.google.dev/api/generate-content) |
| `grok` 或 `xai` | `XAI_API_KEY` | [xAI Responses](https://docs.x.ai/developers/rest-api-reference/inference/responses) |
| `openai` | `OPENAI_API_KEY` | [OpenAI Responses](https://developers.openai.com/api/reference/resources/responses/methods/create) |

“酒馆”按 SillyTavern 处理，本项目支持它的 **Character Card V2 JSON**。在酒馆的角色管理中编辑角色描述、性格、场景、开场白和示例对话，使用角色导出的 JSON 选项。默认使用[卡比角色卡](external/personal-bot/src/kirby.json)，已经编入发布包。若要换成其他角色，可指定单独的 JSON 文件。设置后重启即可；运行机器人时无需启动酒馆。[角色设计指南](https://docs.sillytavern.app/usage/core-concepts/characterdesign/) · [角色管理](https://docs.sillytavern.app/usage/characters/) · [示例角色卡](external/personal-bot/examples/qq-assistant.json)

```dotenv
BOT_PERSONA_FILE=external/personal-bot/examples/qq-assistant.json
```

生产环境把审核过的角色卡放在服务器私有目录并填写绝对路径。留空使用内置卡比。自定义私有角色卡应放在源码目录之外；内置卡的文字随产物分发。适配器仅提取上述角色文本与名字，把开场白和示例作为风格参考，替换 `{{char}}`、`{{user}}`；带未知模板的字段会跳过。PNG 卡、世界书、扩展脚本和整套提示词预设不在本次导入范围。角色内容会提交给模型，应当视为可被对话者探知的文本。

每次聊天仅向选定服务发送角色说明、当前输入及该用户在当前机器人和频道中的最近四轮对话。历史在内存保留 30 分钟，重启即清空；`忘记聊天` 只清除本地记录。模型回复按纯文字发送，无工具调用。每人同时最多一个业务请求，两次请求至少间隔 5 秒；全局并发最多 3 个。每个进程的 AI 和快递指令合计每天最多尝试 100 次（缓存命中也计数，UTC 日界，进程重启重新计数），单次最多请求 2048 个输出 token。供应商端另设用量告警和可用的硬配额，避免重启或多实例放大费用。

## 天气和快递

天气使用 Open-Meteo 的地名检索和当前天气接口。个人非商业使用无需密钥。同名城市采用服务返回的首个中国匹配，回复中附带可用的省份。天气服务收到城市名和坐标。[地名服务](https://open-meteo.com/en/docs/geocoding-api) · [天气服务](https://open-meteo.com/en/docs)

快递使用快递100企业实时查询，在私有环境文件中填写 `KUAIDI100_CUSTOMER` 和 `KUAIDI100_KEY`。完整运单号和承运商会发送给快递100，返回 QQ 的内容仅保留状态摘要；该命令不会调用模型。同一运单的查询结果在单进程内复用 30 分钟。仅查询自己有权查看的包裹。顺丰、顺丰快运和中通需要手机号验证，请使用承运商官方渠道。机器人不会索取手机号。[快递100实时查询](https://api.kuaidi100.com/document/5f0ffb5ebc8da837cbd8aefc.html)

## 构建产物并上传服务器

本地运行以下命令。发布脚本使用明确的文件清单，仅包含编译后的业务代码、运行清单、Yarn 与锁文件、专用生产配置。生产配置启用 HTTP 客户端、业务插件和按凭据启用的 Satori 适配器，没有管理控制台。开发库的 `.env*`、角色私有文件、日志、数据库、LLBot 登录态和本机依赖均不打包。

```bash
npm test
npm run release
tar -tzf release/qq-bot.tar.gz
```

只上传 `release/qq-bot.tar.gz`。例如传到普通服务账号的家目录后，在**新的空版本目录**解压，在服务器系统和 CPU 架构上安装锁定的依赖。服务器需安装兼容的 Node，项目在 26.13.1 验证。归档内置了 Yarn，可以直接用 Node 运行，无需在服务器全局安装 Yarn。

```bash
tar -xzf ~/qq-bot.tar.gz
node .yarn/releases/yarn-4.5.3.cjs install --immutable
```

在服务器上的私有目录独立创建生产环境文件，权限设为 600。用普通账号启动，例如 `node --env-file=/私有目录/qq-bot.env node_modules/koishi/bin.js start`（Node 26）。也可以用 systemd 的 `EnvironmentFile=` 与 `npm start`，将 `WorkingDirectory` 指向解压目录。先安装依赖再给运行进程注入密钥，避免安装脚本继承生产凭据。生产环境不需要开放 Koishi 入站端口。保留上一版解压目录即可切换代码回滚。

密钥只填写在受限文件或服务器密钥管理工具中。不要通过 QQ、角色卡、截图、控制台调试日志或 Git 传递密钥。若密钥曾进入代码仓库或上传包，到供应商后台撤销并重签。LLBot 自身的授权、WebUI 密码和 QQ 登录卷留在接入层单独管理。
