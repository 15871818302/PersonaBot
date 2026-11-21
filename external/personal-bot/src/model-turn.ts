import { modelConfig } from './models'
import { PublicError } from './public-error'

export type Message = { role: 'user' | 'assistant', content: string }
type GeminiPart = { text?: string, thought?: boolean, functionCall?: { id?: string, name: string, args: unknown } }
type ChatCall = { id: string, function: { name: string, arguments: string } }
type ResponseMessage = {
  type: string
  role?: string
  name?: string
  arguments?: string
  call_id?: string
  phase?: string
  content?: { type: string, text?: string, refusal?: string }[]
}
type ProviderReply = {
  candidates?: { content?: { parts?: GeminiPart[] } }[]
  output?: ResponseMessage[]
  choices?: { message?: { content?: string, refusal?: string, tool_calls?: ChatCall[] } }[]
}

const outputTokens = 2048
const responseByteLimit = 256 * 1024

export function clipped(text: string, limit: number) {
  if (text.length <= limit) return text
  return text.slice(0, limit).replace(/[\uD800-\uDBFF]$/, '')
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

function visibleReply(reply: ProviderReply, protocol: string): string {
  let parts: (string | undefined)[]
  if (protocol === 'gemini') {
    parts = reply.candidates?.[0]?.content?.parts?.filter(part => !part.thought).map(part => part.text) ?? []
  } else if (protocol === 'openai-compatible') {
    const message = reply.choices?.[0]?.message
    parts = [message?.content || message?.refusal]
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

export type FunctionTool = {
  name: string
  description: string
  parameters: { type: 'object', properties: Record<string, { type: 'string', description?: string, enum?: string[] }>, required: string[] }
}

type Step = { text: string, call?: undefined } | {
  text?: undefined
  call: { name: string, args: unknown, resume: (result: object) => object[] }
}

function parseArguments(raw?: string): unknown {
  try { return JSON.parse(raw ?? '') } catch { return null }
}

// Keep the provider's original call (including signatures and reasoning items)
// only until its matching tool result has been delivered.
function readStep(reply: ProviderReply, protocol: string, tool?: FunctionTool): Step {
  const invalid = () => new PublicError('模型返回了无效的工具调用，请换个说法重试。')
  if (protocol === 'gemini') {
    const parts = reply.candidates?.[0]?.content?.parts ?? []
    const calls = parts.flatMap(part => part.functionCall ? [part.functionCall] : [])
    if (calls.length) {
      const { name, args, id } = calls[0]
      if (!tool || calls.length !== 1 || name !== tool.name) throw invalid()
      return { call: { name, args, resume: response => [
        { role: 'model', parts }, { role: 'user', parts: [{ functionResponse: { name, ...(id && { id }), response } }] },
      ] } }
    }
  } else if (protocol === 'openai-compatible') {
    const message = reply.choices?.[0]?.message
    const calls = message?.tool_calls
    if (calls?.length) {
      const { id, function: fn } = calls[0]
      if (!tool || calls.length !== 1 || !id || fn?.name !== tool.name) throw invalid()
      return { call: { name: fn.name, args: parseArguments(fn.arguments), resume: response => [
        { ...message, role: 'assistant' }, { role: 'tool', tool_call_id: id, content: JSON.stringify(response) },
      ] } }
    }
  } else {
    const calls = reply.output?.filter(item => item.type === 'function_call')
    if (calls?.length) {
      const { name, arguments: raw, call_id } = calls[0]
      if (!tool || calls.length !== 1 || !call_id || name !== tool.name) throw invalid()
      return { call: { name, args: parseArguments(raw), resume: response => [
        ...reply.output, { type: 'function_call_output', call_id, output: JSON.stringify(response) },
      ] } }
    }
  }
  return { text: visibleReply(reply, protocol) }
}

export class ToolRequestRejected extends PublicError {}

export async function modelStep(system: string, messages: Message[], config: ReturnType<typeof modelConfig>,
  options: { tool?: FunctionTool, continuation?: object[], deadline?: AbortSignal } = {}): Promise<Step> {
  const { tool, continuation = [], deadline } = options
  if (deadline?.aborted) throw new PublicError('这次聊天超时了，请稍后再试。')
  const { protocol, model, key, base } = config
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  let url: string
  let body: object
  if (protocol === 'gemini') {
    url = `${base}/models/${encodeURIComponent(model)}:generateContent`
    headers['x-goog-api-key'] = key
    body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [...messages.map(({ role, content }) => ({
        role: role === 'assistant' ? 'model' : 'user',
        parts: [{ text: content }],
      })), ...continuation],
      ...(tool && { tools: [{ functionDeclarations: [tool] }] }),
      ...(continuation.length > 0 && { toolConfig: { functionCallingConfig: { mode: 'NONE' } } }),
      generationConfig: { maxOutputTokens: outputTokens },
    }
  } else {
    headers.Authorization = `Bearer ${key}`
    const input = [{ role: 'system', content: system }, ...messages, ...continuation]
    if (protocol === 'openai-compatible') {
      url = base + '/chat/completions'
      body = {
        model, messages: input, max_tokens: outputTokens,
        ...(tool && { tools: [{ type: 'function', function: tool }], parallel_tool_calls: false }),
        ...(continuation.length > 0 && { tool_choice: 'none' }),
      }
    } else {
      url = base + '/responses'
      body = {
        model, input, store: false, max_output_tokens: outputTokens,
        ...(tool && { tools: [{ type: 'function', ...tool, strict: false }], parallel_tool_calls: false }),
        ...(tool && !continuation.length && { include: ['reasoning.encrypted_content'] }),
        ...(continuation.length > 0 && { tool_choice: 'none' }),
      }
    }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30_000)
  try {
    const signal = deadline ? AbortSignal.any([controller.signal, deadline]) : controller.signal
    const response = await fetch(url, {
      method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal,
    })
    if (tool && !continuation.length && [400, 422].includes(response.status)) throw new ToolRequestRejected('当前模型未接受工具请求。')
    if (!response.ok) throw new PublicError(`模型请求失败（HTTP ${response.status}）。`)
    return readStep(await readReply(response), protocol, continuation.length ? undefined : tool)
  } catch (error) {
    if (error instanceof PublicError) throw error
    if (controller.signal.aborted || deadline?.aborted) throw new PublicError('模型请求超时，请稍后重试。')
    throw new PublicError('模型服务连接失败或响应无效，请稍后重试。')
  } finally {
    clearTimeout(timeout)
    controller.abort()
  }
}
