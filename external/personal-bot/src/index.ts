import { Context, h, Session } from 'koishi'
import { join } from 'node:path'
import { chat } from './chat'
import { listModels, modelConfig, ModelPreferences } from './models'
import { loadPersona } from './persona'
import { PublicError } from './public-error'
import { track, weather } from './queries'

export const name = 'personal-bot'

type Turn = { role: 'user' | 'assistant', content: string }
type Conversation = { turns: Turn[], expires: number, modelKey: string }
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
    if (!access(session) || !isOwner(session)) return '仅限机器人所有者本人操作。'
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

  async function request(session: Session, action: () => Promise<string>, metered = false) {
    const user = session.platform + ':' + session.userId
    const now = Date.now()
    if (busy.has(user) || busy.size >= 3 || now < (cooldowns.get(user) ?? 0)) {
      return '请求较频繁，请稍后再试。'
    }
    if (metered) {
      const date = new Date(now).toISOString().slice(0, 10)
      if (date !== budgetDate) {
        callsToday = 0
        budgetDate = date
      }
      if (callsToday >= 100) return '今天的 AI 与快递查询共用额度已用完。'
      callsToday++
    }
    busy.add(user)
    cooldowns.set(user, now + 5000)
    try {
      return h.text(await action())
    } catch (error) {
      return error instanceof PublicError ? h.text(error.message) : '服务暂时不可用，请联系管理员检查配置。'
    } finally {
      busy.delete(user)
    }
  }

  ctx.command('ping', '检查机器人是否在线').action(() => 'pong')

  ctx.command('model-list', '列出可切换的 AI 接口和预设').alias('模型列表')
    .action(({ session }) => manage(session, listModels))
  ctx.command('model-current', '查看自己的聊天模型').alias('当前模型')
    .action(({ session }) => manage(session, () => {
      const choice = preferences.get(preferenceKey(session))
      const config = modelConfig(choice)
      return `当前模型：${config.name} / ${config.model}${choice ? '' : '（默认）'}`
    }))
  ctx.command('model-switch [name:string] [model:string]', '切换自己的 API 和模型').alias('切换模型')
    .action(({ session }, name, model) => manage(session, () => {
      if (!name) return '用法：切换模型 厂商 模型ID，或 切换模型 预设名，或 切换模型 默认'
      if (busy.has(session.platform + ':' + session.userId)) return '请等当前请求结束后再切换。'
      const user = preferenceKey(session)
      if (name === '默认') {
        if (model) return '恢复默认配置请发送「切换模型 默认」。'
        preferences.set(user)
        return '已恢复服务器默认模型。'
      }
      const config = modelConfig({ name, model })
      preferences.set(user, { name: config.name, model })
      return `已切换到 ${config.name} / ${config.model}。`
    }))

  function replyToChat(session: Session, message: string) {
    if (!message?.trim() || message.length > 4096) return '直接发送你的问题就好，最多 4096 个字符。'
    const elements = h.parse(message)
    if (elements.some(element => element.type !== 'text')) return '聊天目前只接受文字。'
    const text = elements.map(element => element.attrs.content).join('').trim()
    return request(session, async () => {
      const key = conversationKey(session)
      const choice = isOwner(session) ? preferences.get(preferenceKey(session)) : undefined
      const config = modelConfig(choice)
      const modelKey = JSON.stringify([config.protocol, config.base, config.model])
      const previous = conversations.get(key)
      const turns = previous && previous.modelKey === modelKey && previous.expires > Date.now() ? previous.turns : []
      persona ??= loadPersona()
      await session.send('噗哟～让我想一想！')
      const answer = await chat(persona, turns, text, config)
      const next: Turn[] = [...turns, { role: 'user', content: text }, { role: 'assistant', content: answer }]
      conversations.delete(key)
      if (conversations.size >= 100) conversations.delete(conversations.keys().next().value!)
      conversations.set(key, { turns: next.slice(-8), expires: Date.now() + halfHour, modelKey })
      return answer
    }, true)
  }

  ctx.command('ai <message:text>', '与预设角色聊天').alias('聊天').action(({ session }, message) => {
    if (!access(session)) return '当前会话未获授权。'
    return replyToChat(session, message)
  })

  ctx.middleware((session, next) => {
    if (!access(session) || session.argv?.command) return next()
    const { atSelf, content } = session.stripped
    if ((!session.isDirect && !atSelf) || !content) return next()
    return replyToChat(session, content)
  })

  ctx.command('forget', '清除当前会话的聊天记录').alias('忘记聊天').action(({ session }) => {
    if (!access(session)) return '当前会话未获授权。'
    if (busy.has(session.platform + ':' + session.userId)) return '请等当前请求结束后再清除。'
    conversations.delete(conversationKey(session))
    return '已清除本次会话的聊天记录。'
  })

  ctx.command('weather <city:text>', '查询城市天气').alias('天气').action(({ session }, city) => {
    if (!access(session)) return '当前会话未获授权。'
    if (!city?.trim()) return '用法：天气 北京'
    return request(session, () => weather(city))
  })

  ctx.command('parcel <carrier:string> <number:string>', '私聊查询快递状态').alias('快递').action(({ session }, carrier, number) => {
    if (!access(session, true)) return '快递查询仅对已授权的私聊开放。'
    if (!carrier || !number) return '用法：快递 韵达 运单号'
    return request(session, () => track(carrier, number), true)
  })
}
