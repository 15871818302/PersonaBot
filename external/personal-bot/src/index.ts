import { Context, h, Session } from 'koishi'
import { join } from 'node:path'
import { chat, Turn } from './chat'
import { listModels, modelConfig, ModelPreferences } from './models'
import { loadPersona } from './persona'
import { PublicError } from './public-error'
import { firstPlace } from './weather-places'
import { track, weather } from './queries'

export const name = 'personal-bot'

type Conversation = { turns: Turn[], expires: number, modelKey: string }
const accessHint = '我还没拿到在这里帮忙的许可。请机器人主人看看白名单，好吗？'
const halfHour = 30 * 60_000

function allowlist(value = '') {
  return new Set(value.split(',').map(item => item.trim()).filter(Boolean))
}

export function apply(ctx: Context) {
  const users = allowlist(process.env.BOT_ALLOWED_USERS)
  const groups = allowlist(process.env.BOT_ALLOWED_GROUPS)
  const owner = process.env.BOT_OWNER_ID?.trim()
  const preferences = new ModelPreferences(join(ctx.baseDir ?? process.cwd(), 'data', 'model-preferences'))
  const conversations = new Map<string, Conversation>()
  const cooldowns = new Map<string, number>()
  const busy = new Set<string>()
  let activeResearchers = 0
  function acquireResearchSlot() {
    if (activeResearchers >= 2) return
    activeResearchers++
    return () => { activeResearchers-- }
  }

  let budgetDate = ''
  let callsToday = 0
  let persona: string | undefined

  function access(session: Session | undefined, privateOnly = false) {
    if (!session?.platform || !session.userId || session.userId === session.selfId) return false
    if (!users.has(session.platform + ':' + session.userId)) return false
    if (session.isDirect) return true
    return !privateOnly && !!session.guildId && groups.has(session.platform + ':' + session.guildId)
  }

  function conversationKey(session: Session) {
    return JSON.stringify([session.platform, session.selfId, session.guildId, session.channelId, session.userId])
  }

  function isOwner(session: Session) {
    return session.platform === 'qq' && owner === 'qq:' + session.userId
  }

  function preferenceKey(session: Session) {
    return JSON.stringify([session.platform, session.selfId, session.userId])
  }

  function manage(session: Session, action: () => string) {
    if (!access(session) || !isOwner(session)) return '这几条模型指令，我得听机器人主人本人的哦。'
    try {
      return h.text(action())
    } catch (error) {
      return error instanceof PublicError ? error.message : '模型配置读取失败。'
    }
  }

  ctx.setInterval(() => {
    const now = Date.now()
    for (const [key, conversation] of conversations) {
      if (conversation.expires <= now) conversations.delete(key)
    }
    for (const [key, until] of cooldowns) {
      if (until <= now) cooldowns.delete(key)
    }
  }, 60_000)

  function chargeCall() {
    const date = new Date().toISOString().slice(0, 10)
    if (date !== budgetDate) {
      callsToday = 0
      budgetDate = date
    }
    if (callsToday >= 100) throw new PublicError('今天的 AI 与快递查询共用额度已用完。')
    callsToday++
  }

  async function request(session: Session, action: () => Promise<string>, metered = false) {
    const user = session.platform + ':' + session.userId
    const now = Date.now()
    if (busy.has(user) || busy.size >= 3 || now < (cooldowns.get(user) ?? 0)) {
      return '让我喘口气，过一会儿再来找我，好吗？'
    }
    busy.add(user)
    cooldowns.set(user, now + 5000)
    try {
      if (metered) chargeCall()
      return h.text(await action())
    } catch (error) {
      return error instanceof PublicError ? h.text(error.message) : '服务暂时不可用，请联系管理员检查配置。'
    } finally {
      busy.delete(user)
    }
  }

  // Keep the inspect plugin's diagnostic fields and help's command syntax copyable.
  ctx.i18n.define('$zh-CN', 'commands.inspect', {
    usage: '想看自己的信息就发 inspect。想看群友或频道的话，试试下面两种写法。\ninspect @user\ninspect #channel',
    messages: {
      user: '我找到这位朋友的用户 ID 啦：{id}',
      channel: '我帮你看了一眼，频道 ID 是 {id}。',
      message: '我把这条消息上的编号都抄好啦，给你！\n平台名：{platform}\n消息 ID：{messageId}\n频道 ID：{channelId}\n群组 ID：{guildId}\n用户 ID：{userId}\n自身 ID：{selfId}',
    },
  })
  ctx.i18n.define('$zh-CN', 'commands.help.messages', {
    'global-prolog': '这些事我可以帮忙{0}：',
    'global-epilog': '想知道哪条怎么用？发「{0}help 指令名」，我讲给你听。',
    'subcommand-prolog': '你还可以这样叫我帮忙{0}：',
    'command-title': '和我说「{0}」就好。',
    'command-aliases': '这些叫法我也认得：{0}。',
    'command-examples': '你可以这样跟我说：',
    'command-authority': '这条需要的最低权限是 {0} 级哦。',
    'available-options': '你还可以选这些：',
    'available-options-with-authority': '你还可以选这些，括号里是需要的权限等级：',
    'hint-authority': '我把最低权限等级写在括号里了',
    'hint-subcommand': '看到星号就可以继续往下看子指令',
  })

  const isKirby = !process.env.BOT_PERSONA_FILE?.trim()
  const pingReply = isKirby ? '噗哟！接住你的 ping 啦，回你一个 pong！' : '我在，回你一个 pong。'
  ctx.command('ping', '喊我一声，看看我在不在').action(() => pingReply)

  ctx.command('model-list', '看看我能用哪些模型和预设').alias('模型列表')
    .action(({ session }) => manage(session, listModels))
  ctx.command('model-current', '看看我现在用哪个模型和你聊天').alias('当前模型')
    .action(({ session }) => manage(session, () => {
      const choice = preferences.get(preferenceKey(session))
      const config = modelConfig(choice)
      return `我现在用 ${config.name} / ${config.model}${choice ? '' : '（默认）'} 陪你聊天。`
    }))
  ctx.command('model-switch [name:string] [model:string]', '帮你换个聊天模型').alias('切换模型')
    .action(({ session }, name, model) => manage(session, () => {
      if (!name) return '想让我换哪个模型？发「切换模型 预设名」就好。也可以发「切换模型 厂商 模型ID」，或者用「切换模型 默认」换回去。'
      if (busy.has(session.platform + ':' + session.userId)) return '我还在忙你刚才那件事呢。等我忙完，再来找我换模型吧。'
      const user = preferenceKey(session)
      if (name === '默认') {
        if (model) return '想换回原来那个呀？只要跟我说「切换模型 默认」就好。'
        preferences.set(user)
        return '好啦，我换回服务器默认的模型了。'
      }
      const config = modelConfig({ name, model })
      preferences.set(user, { name: config.name, model })
      return `换好啦！接下来我用 ${config.name} / ${config.model} 和你聊。`
    }))

  function lookupWeather(session: Session, city: string) {
    if (!access(session)) return accessHint
    if (!city?.trim()) return '想知道哪座城的天气呀？报个地名，我去瞧瞧。比如「天气 北京」。'
    return request(session, () => weather(city))
  }

  function lookupParcel(session: Session, carrier: string, number: string) {
    if (!access(session, true)) {
      if (session?.isDirect) return '我还没拿到帮你查包裹的许可。请机器人主人先把你加进私聊白名单，好吗？'
      return '把单号收好，咱们私聊再说吧。我只能在已授权的私聊里帮你查包裹哦。'
    }
    if (!carrier || !number) return '是哪家的包裹呀？把快递公司和运单号一起告诉我，照着「快递 韵达 运单号」填就好。'
    return request(session, () => track(carrier, number), true)
  }

  function weatherCityIn(elements: ReturnType<typeof h.parse>) {
    const visible = elements.map(element => element.type === 'text' ? element.attrs.content : ' ').join('')
    return visible.includes('天气') ? firstPlace(visible) : undefined
  }

  function quotedText(session: Session) {
    const quote = session.quote
    if (!quote || (quote.channel?.id && quote.channel.id !== session.channelId)
      || (quote.guild?.id && quote.guild.id !== session.guildId)) return
    const elements = quote.elements ?? h.parse(quote.content || '')
    return elements.map(el => el.type === 'text' ? el.attrs.content : ' ').join('').trim().slice(0, 512) || undefined
  }

  function replyToChat(session: Session, message: string) {
    if (message?.length > 4096) {
      return isKirby ? '哇，这么大一块，我一口吞不下啦！分几段给我吧，每条最多 4096 个字符。'
        : '这段有点长，分几条发给我好吗？每条最多 4096 个字符。'
    }
    if (!message?.trim()) return '我挪过来啦。你说，我听着呢！'
    const elements = h.parse(message)
    const city = weatherCityIn(elements)
    if (city) return lookupWeather(session, city)
    if (elements.some(element => element.type !== 'text')) return '我现在只读得懂文字。你想让我看什么？打几个字告诉我吧。'
    const text = elements.map(element => element.attrs.content).join('').trim()
    const query = text.replace(/[？?！!。]+$/u, '').trim()
    const parcel = /^(?:请|帮我)?(?:查一下|查询|查)?快递(?:\s+(.*))?$/u.exec(query)
    if (parcel) {
      const [carrier, number, extra] = (parcel[1] || '').trim().split(/\s+/)
      return lookupParcel(session, carrier, extra ? '' : number)
    }
    return request(session, async () => {
      const key = conversationKey(session)
      const choice = isOwner(session) ? preferences.get(preferenceKey(session)) : undefined
      const config = modelConfig(choice)
      const modelKey = JSON.stringify([config.protocol, config.base, config.model])
      const previous = conversations.get(key)
      const turns = previous && previous.modelKey === modelKey && previous.expires > Date.now() ? previous.turns : []
      persona ??= loadPersona()
      const searchKey = process.env.TAVILY_API_KEY?.trim()
      const lookup = searchKey && !process.env.BOT_PERSONA_FILE?.trim() ? { key: searchKey, chargeFollowup: chargeCall, acquire: acquireResearchSlot } : undefined
      const quote = quotedText(session)
      const answer = await chat(persona, turns, text, config, lookup, quote)
      const next: Turn[] = [...turns, { role: 'user', content: text, quote }, { role: 'assistant', content: answer }]
      conversations.delete(key)
      if (conversations.size >= 100) conversations.delete(conversations.keys().next().value!)
      conversations.set(key, { turns: next.slice(-8), expires: Date.now() + halfHour, modelKey })
      return answer
    }, true)
  }

  ctx.command('ai <message:text>', '来找我聊聊天').alias('聊天').action(({ session }, message) => {
    if (!access(session)) return accessHint
    return replyToChat(session, message)
  })

  ctx.middleware((session, next) => {
    if (!access(session) || session.argv?.command) return next()
    const { atSelf, content } = session.stripped
    if (!content) return next()
    if (!session.isDirect && !atSelf) {
      if (content.length > 4096 || !content.includes('天气')) return next()
      const city = weatherCityIn(h.parse(content))
      return city ? lookupWeather(session, city) : next()
    }
    return replyToChat(session, content)
  })

  ctx.command('forget', '让我忘掉这次会话的聊天记录').alias('忘记聊天').action(({ session }) => {
    if (!access(session)) return accessHint
    if (busy.has(session.platform + ':' + session.userId)) return '我还在忙刚才那件事呢。等我忙完，再跟我说一声「忘记聊天」吧。'
    conversations.delete(conversationKey(session))
    return '我把咱们这次的聊天记录清掉啦。来，从哪句话重新聊起？'
  })

  ctx.command('weather <city:text>', '让我帮你看看当地的天气').alias('天气').action(({ session }, city) => {
    return lookupWeather(session, firstPlace(city || '') || city)
  })

  ctx.command('parcel <carrier:string> <number:string>', '私聊告诉我单号，我帮你看看包裹到哪了').alias('快递').action(({ session }, carrier, number) => {
    return lookupParcel(session, carrier, number)
  })
}
