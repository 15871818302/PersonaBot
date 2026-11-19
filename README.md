# 个人 QQ 助手

Koishi 使用 QQ 官方机器人适配器接收单聊和群 @ 消息，直接发送文字即可聊天，也可以用指令查询天气或快递。天气无需密钥。聊天和业务指令默认仅向白名单开放，`ping` 和 `inspect` 可在首次接入时使用。

| 在 QQ 中发送 | 行为 |
| --- | --- |
| 私聊发 `你好`，或在已授权的群里 @机器人 发 `你好` | 使用当前用户选定的模型和预设角色聊天，首次使用服务器默认模型 |
| `模型列表`、`当前模型` | 所有者查看本机配置的接口、预设或当前选择 |
| `切换模型 厂商 模型ID`、`切换模型 预设名`、`切换模型 默认` | 所有者更改自己的模型或恢复默认值 |
| `忘记聊天` | 清除当前用户在当前会话中的本地聊天历史 |
| `天气 杭州` | 查询中国城市的当前气温、湿度、天气状况和北京时间 |
| `快递 韵达 运单号` | 仅限授权私聊，返回单号末四位、状态和最新记录时间 |
| `ping` | 回复 `pong` |

## 接入腾讯官方 QQ 机器人

1. 在 QQ 开放平台创建机器人，获取 **AppID** 和 **AppSecret**，确认应用已开通要测试的单聊或群 @ 场景。如果通过腾讯沙箱测试，先在平台添加测试成员或测试群。[腾讯接入文档](https://bot.q.qq.com/wiki/develop/api-v2/)
2. 在项目目录安装锁定依赖，并在首次配置时创建私有环境文件。项目已包含 `@koishijs/plugin-adapter-qq`。[Koishi QQ 适配器](https://koishi.chat/zh-CN/plugins/adapter/qq)

   ```bash
   node .yarn/releases/yarn-4.5.3.cjs install --immutable
   test -e .env.local || install -m 600 deploy/qq-bot.env.example .env.local
   ```

3. 编辑 `.env.local`，将 AppID 填入 `QQ_APP_ID`，AppSecret 填入 `QQ_APP_SECRET`。使用腾讯沙箱环境时设 `QQ_SANDBOX=true`，正式环境使用 `false`。运行 `npm run dev`。Koishi 会换取访问凭证，通过出站 WebSocket 订阅单聊和群 @ 事件。开放平台如要求配置 IP 白名单，请填写运行 Koishi 的机器访问公网时的出口 IP。[腾讯鉴权说明](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/api-use.html) · [腾讯事件订阅](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html)
4. 用主号打开机器人的对话，发 `ping` 确认收到 `pong`，再发 `inspect`。把回复中的**平台名**和**用户 ID** 用英文冒号连接，写入 `BOT_ALLOWED_USERS`，例如 `qq:你的用户OpenID`。旧配置里的个人 QQ 号码需要换成这次查询的 ID。
5. 需要群聊时，在目标群里 **@机器人 inspect**，把该次回复的用户 ID 加入 `BOT_ALLOWED_USERS`，群组 ID 加入 `BOT_ALLOWED_GROUPS`，两处均带 `qq:` 前缀。多个值用英文逗号分隔。重启 Koishi 后发 `天气 杭州` 验证授权。快递查询仅限已授权的私聊。

等待平台凭据期间也可运行 `npm run dev`。本地 Koishi 控制台通常在 `http://127.0.0.1:5140`，从控制台进入沙盒即可测试指令。沙盒业务指令使用该会话的 `inspect` 结果单独授权。

## 模型与酒馆角色

在 `.env.local` 或服务器环境里配置要使用的服务。单个服务填写 `AI_PROVIDER`（接口格式）、`AI_MODEL`、`AI_BASE_URL` 和密钥。基础地址由你指定，包含版本前缀，例如 `https://gateway.example/v1`。如果密钥已经保存在某个环境变量里，将它的**变量名**填入 `AI_KEY_ENV` 即可复用。

| 接口格式 | 请求路径 |
| --- | --- |
| `openai-compatible` | `/chat/completions` |
| `responses`（兼容原有的 `openai`、`grok`、`xai` 写法） | `/responses` |
| `gemini` | `/models/{模型ID}:generateContent` |

**通过 Amazon Bedrock 调用 Grok 的示例**（美国东部，使用 Bedrock API key 进行 Bearer 鉴权）。按账号已开通的区域和推理配置 ID 调整。AWS IAM Access Key / Secret Key 的 SigV4 签名属于另一种鉴权方式。[AWS Grok 模型与区域说明](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-xai-grok-4-7.html) · [Bedrock Chat Completions](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-chat-completions.html)

```dotenv
AI_PROVIDER=openai-compatible
AI_BASE_URL=https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1
AI_MODEL=us.xai.grok-4.7
AI_API_KEY=你的Bedrock_API_key
```

第三方提供的 Grok 或 Gemini 如果使用 Chat Completions，沿用上例并替换地址、模型 ID 和密钥。如果提供 Gemini 原生接口，则用 `AI_PROVIDER=gemini`、该服务商的 `GEMINI_API_KEY` 及其基础地址。保存后重启 Koishi，用已授权的 QQ 账号私聊发送 `用一句话介绍自己`。[Gemini 原生接口](https://ai.google.dev/api/generate-content) · [Gemini 的 OpenAI 兼容接口](https://ai.google.dev/gemini-api/docs/openai)

### 从 QQ 切换接口和模型

用本人主号私聊机器人发送 `inspect`，将该用户的 `qq:OpenID` 同时填入 `BOT_OWNER_ID` 和 `BOT_ALLOWED_USERS`。管理权限仅绑定这一个 QQ 身份，`BOT_OWNER_ID` 留空即关闭管理指令。其他已授权用户继续使用 `AI_PROVIDER` 与 `AI_MODEL` 指定的默认模型。

重启 Koishi 后，发送 `模型列表` 查看环境中配置的名称。发送 `切换模型 名称` 使用该服务配置的模型，也可以发送 `切换模型 名称 模型ID` 指定其他模型。发送 `当前模型` 查看选择，`切换模型 默认` 恢复 `AI_PROVIDER` 指定的服务。切换即时生效；下一次聊天只使用当前接口和模型的上下文。

要在多个网关间切换，可在私有环境文件中一次性定义命名预设。例如下面的 `bedrock` 预设通过 `keyEnv` 读取环境变量 `BEDROCK_API_KEY`，可改成你已经存放该服务密钥的变量名。每个预设独立指定基础地址。`AI_PROVIDER=bedrock` 可将这个预设设为默认，直接复用它的模型、地址和密钥配置。编辑预设后重启 Koishi，再发 `切换模型 bedrock`；同一个接口也可用 `切换模型 bedrock 其他模型ID` 指定其他模型。

```dotenv
AI_PRESETS='{"bedrock":{"provider":"openai-compatible","model":"us.xai.grok-4.7","baseUrl":"https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1","keyEnv":"BEDROCK_API_KEY"}}'
```

选择按机器人和用户保存到 Koishi 工作目录下的 `data/model-preferences/`，重启后继续有效。使用容器或切换生产发布目录时请挂载或复用这个目录。状态文件只保存预设名或厂商名以及手动指定的模型 ID。

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

本地运行以下命令。发布脚本使用明确的文件清单，仅包含编译后的业务代码、运行清单、Yarn 与锁文件、专用生产配置。生产配置加载业务插件、身份查询和 HTTP 客户端，填好两项 QQ 凭据后启用官方适配器。发布包排除管理控制台、私有环境文件、日志、数据库和本机依赖。

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

密钥只填写在受限文件或服务器密钥管理工具中。不要通过 QQ、角色卡、截图、控制台调试日志或 Git 传递密钥。若密钥曾进入代码仓库或上传包，到供应商后台撤销并重签。
