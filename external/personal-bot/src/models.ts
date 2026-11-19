import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PublicError } from './public-error'

type Preset = { provider: string, model: string, baseUrl: string, keyEnv?: string }
type NamedPreset = Preset & { name: string }
export type ModelChoice = { name: string, model?: string }

function configuredModels(): Map<string, NamedPreset> {
  const result = new Map<string, NamedPreset>()
  try {
    const entries = JSON.parse(process.env.AI_PRESETS?.trim() || '{}')
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error()
    for (const [name, value] of Object.entries(entries) as [string, Preset][]) {
      const lookup = name.toLowerCase()
      if (!/^[a-z][a-z0-9_-]{0,31}$/i.test(name) || result.has(lookup) || !value
        || typeof value.provider !== 'string' || typeof value.model !== 'string'
        || typeof value.baseUrl !== 'string'
        || (value.keyEnv !== undefined && (typeof value.keyEnv !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(value.keyEnv)))) throw new Error()
      result.set(lookup, { ...value, name })
    }
  } catch {
    throw new PublicError('AI_PRESETS 格式有误，请检查服务器上的配置。')
  }

  const name = process.env.AI_PROVIDER?.trim()
  if (name && !result.has(name.toLowerCase())) {
    result.set(name.toLowerCase(), {
      name, provider: name, model: process.env.AI_MODEL?.trim() || '',
      baseUrl: process.env.AI_BASE_URL?.trim() || '', keyEnv: process.env.AI_KEY_ENV?.trim(),
    })
  }
  return result
}

export function listModels() {
  const items = Array.from(configuredModels().values(), ({ name, model }) => model ? name + '（' + model + '）' : name)
  if (!items.length) return '尚未配置 AI 服务，请先填写 AI_PROVIDER 或 AI_PRESETS。'
  return [...items, '用法：切换模型 名称 [模型ID]'].join('\n')
}

export function modelConfig(choice?: ModelChoice) {
  const name = (choice?.name ?? process.env.AI_PROVIDER ?? '').trim().toLowerCase()
  if (!name) throw new PublicError('请先配置 AI_PROVIDER 或使用「切换模型」。')
  const config = configuredModels().get(name)
  if (!config) throw new PublicError('未知厂商或预设，请发送「模型列表」。')
  const provider = config.provider.trim()
  const protocol = provider.toLowerCase()
  if (!['openai', 'grok', 'xai', 'responses', 'gemini', 'openai-compatible'].includes(protocol)) {
    throw new PublicError('不支持此 AI 接口格式，请检查 AI_PROVIDER 或预设的 provider。')
  }
  const base = config.baseUrl.trim()
  if (!base || !URL.canParse(base)) throw new PublicError('请在 AI_BASE_URL 或预设 baseUrl 中填写完整的 API 基础地址。')
  const url = new URL(base)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || /[?#]/.test(base)) {
    throw new PublicError('AI_BASE_URL 需使用 HTTP 或 HTTPS，请移除地址中的账户信息、查询参数和片段。')
  }
  const model = (choice?.model ?? config.model).trim()
  if (!model || model.length > 256 || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*(\/[a-zA-Z0-9][a-zA-Z0-9._:-]*)*$/.test(model)
    || (protocol === 'gemini' && model.includes('/'))) {
    throw new PublicError('请在切换指令或 AI_MODEL 中填写有效的模型 ID。')
  }
  // Keep the existing environment variable convention for configurations without keyEnv.
  const legacyName = protocol === 'grok' ? 'xai' : protocol
  const keyName = config.keyEnv || (protocol === 'openai-compatible' || protocol === 'responses'
    ? 'AI_API_KEY' : legacyName.toUpperCase() + '_API_KEY')
  if (!/^[A-Z][A-Z0-9_]*$/.test(keyName)) throw new PublicError('AI_KEY_ENV 或 keyEnv 应填写环境变量名。')
  const key = process.env[keyName]?.trim()
  if (!key) throw new PublicError(`请先配置 ${keyName}。`)
  return { name: config.name, provider, protocol, model, key, base: url.href.replace(/\/+$/, '') }
}

export class ModelPreferences {
  constructor(private directory: string) {}

  private file(user: string) {
    return join(this.directory, createHash('sha256').update(user).digest('hex') + '.json')
  }

  get(user: string): ModelChoice | undefined {
    try {
      const choice = JSON.parse(readFileSync(this.file(user), 'utf8'))
      if (typeof choice?.name !== 'string' || (choice.model !== undefined && typeof choice.model !== 'string')) throw new Error()
      return choice
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw new PublicError('无法读取已保存的模型选择，可用「切换模型 默认」恢复。')
    }
  }

  set(user: string, choice?: ModelChoice) {
    const file = this.file(user)
    try {
      if (!choice) return rmSync(file, { force: true })
      mkdirSync(this.directory, { recursive: true, mode: 0o700 })
      const temporary = file + '.' + randomUUID()
      try {
        writeFileSync(temporary, JSON.stringify(choice), { flag: 'wx', mode: 0o600 })
        renameSync(temporary, file)
      } finally {
        rmSync(temporary, { force: true })
      }
    } catch {
      throw new PublicError('模型选择保存失败，请检查数据目录的写入权限。')
    }
  }
}
