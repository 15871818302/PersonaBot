import { PublicError } from './public-error'

type Message = { role: 'user' | 'assistant', content: string }
type GeminiPart = { text?: string, thought?: boolean }
type ResponseMessage = {
  type: string
  role?: string
  phase?: string
  content?: { type: string, text?: string, refusal?: string }[]
}
type ProviderReply = {
  candidates?: { content?: { parts?: GeminiPart[] } }[]
  output?: ResponseMessage[]
}

const outputTokens = 2048
const responseByteLimit = 256 * 1024

function clipped(text: string, limit: number) {
  if (text.length <= limit) return text
  return text.slice(0, limit).replace(/[\uD800-\uDBFF]$/, '')
}

function configuration() {
  const provider = process.env.AI_PROVIDER?.trim().toLowerCase()
  let keyName: string
  switch (provider) {
    case 'openai':
      keyName = 'OPENAI_API_KEY'
      break
    case 'xai':
    case 'grok':
      keyName = 'XAI_API_KEY'
      break
    case 'gemini':
      keyName = 'GEMINI_API_KEY'
      break
    default:
      throw new PublicError('请先将 AI_PROVIDER 设为 gemini、grok 或 openai。')
  }

  const model = process.env.AI_MODEL?.trim()
  if (!model || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(model)) {
    throw new PublicError('请在 AI_MODEL 中填写有效的模型 ID。')
  }
  const key = process.env[keyName]?.trim()
  if (!key) throw new PublicError(`请先配置 ${keyName}。`)
  return { provider, model, key }
}

async function readReply(response: Response): Promise<ProviderReply> {
  const reader = response.body?.getReader()
  if (!reader) throw new PublicError('模型服务返回了空响应。')
  const chunks: Buffer[] = []
  let size = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > responseByteLimit) throw new PublicError('模型服务返回的数据过大。')
    chunks.push(Buffer.from(value))
  }
  return JSON.parse(Buffer.concat(chunks, size).toString('utf8'))
}

function visibleReply(reply: ProviderReply, gemini: boolean): string {
  let parts: (string | undefined)[]
  if (gemini) {
    parts = reply.candidates?.[0]?.content?.parts?.filter(part => !part.thought).map(part => part.text) ?? []
  } else {
    const messages = reply.output?.filter(item =>
      item.type === 'message' && item.role === 'assistant' && item.phase !== 'commentary'
    ) ?? []
    parts = messages.flatMap(item => (item.content ?? []).map(part => {
      if (part.type === 'output_text') return part.text
      if (part.type === 'refusal') return part.refusal
    }))
  }
  const text = parts.filter(part => typeof part === 'string').join('').trim()
  if (!text) throw new PublicError('模型服务没有返回文字。')
  return clipped(text, 2000)
}

export async function chat(system: string, history: Message[], text: string): Promise<string> {
  const { provider, model, key } = configuration()
  if (system.length > 8192) throw new PublicError('人设和系统提示过长，请缩短后重试。')
  if (text.length > 4096) throw new PublicError('这条消息过长，请分段发送。')
  const messages = history.slice(-12).map(({ role, content }) => ({ role, content: clipped(content, 2048) }))
  messages.push({ role: 'user', content: text })
  const gemini = provider === 'gemini'
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  let url: string
  let body: object
  if (gemini) {
    url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`
    headers['x-goog-api-key'] = key
    body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: messages.map(({ role, content }) => ({
        role: role === 'assistant' ? 'model' : 'user',
        parts: [{ text: content }],
      })),
      generationConfig: { maxOutputTokens: outputTokens },
    }
  } else {
    url = provider === 'openai' ? 'https://api.openai.com/v1/responses' : 'https://api.x.ai/v1/responses'
    headers.Authorization = `Bearer ${key}`
    body = {
      model, input: [{ role: 'system', content: system }, ...messages],
      store: false, max_output_tokens: outputTokens,
    }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30_000)
  try {
    const response = await fetch(url, {
      method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: controller.signal,
    })
    if (!response.ok) throw new PublicError(`模型请求失败（HTTP ${response.status}）。`)
    return visibleReply(await readReply(response), gemini)
  } catch (error) {
    if (error instanceof PublicError) throw error
    if (controller.signal.aborted) throw new PublicError('模型请求超时，请稍后重试。')
    throw new PublicError('模型服务连接失败或响应无效，请稍后重试。')
  } finally {
    clearTimeout(timeout)
    controller.abort()
  }
}
