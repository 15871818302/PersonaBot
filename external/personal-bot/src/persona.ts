import kirby from './kirby.json'
import { readFileSync, statSync } from 'node:fs'

const chatGuidance = '你正在 QQ 里回复当前消息。用自然、简短的中文交流，按对方的需要解释细节。不知道的事就说不知道。'
const maxFileBytes = 1024 * 1024
const maxPromptChars = 8192
const templateDelimiter = /\{\{|\}\}|<%|%>|\{%|%\}|\{#|#\}/

const fields = [
  ['description', '角色描述'],
  ['personality', '性格'],
  ['scenario', '场景'],
  ['first_mes', '开场白示例（仅供参考）'],
  ['mes_example', '对话风格示例（仅供参考）'],
] as const

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readCard(path: string): unknown {
  let raw: string
  try {
    const info = statSync(path)
    if (!info.isFile() || info.size > maxFileBytes) throw new Error()
    raw = readFileSync(path, 'utf8')
  } catch {
    throw new Error('BOT_PERSONA_FILE 必须指向可读取且不超过 1 MiB 的本地 JSON 文件。')
  }
  try {
    return JSON.parse(raw.replace(/^\uFEFF/, ''))
  } catch {
    throw new Error('BOT_PERSONA_FILE 不是有效的 UTF-8 JSON 角色卡。')
  }
}

export function loadPersona(): string {
  const path = process.env.BOT_PERSONA_FILE?.trim()
  const card = path ? readCard(path) : kirby
  if (!isObject(card) || card.spec !== 'chara_card_v2' || card.spec_version !== '2.0' || !isObject(card.data)) {
    throw new Error('BOT_PERSONA_FILE 需要 SillyTavern V2 JSON 角色卡（chara_card_v2，2.0）。')
  }
  const data = card.data
  const name = typeof data.name === 'string' && data.name.trim()
  if (!name || name.length > 128 || /[\r\n]/.test(name) || templateDelimiter.test(name)) {
    throw new Error('BOT_PERSONA_FILE 中的 data.name 应是 1 至 128 个字符的单行纯文本名称。')
  }

  const prompt = [`你是${name}。`, chatGuidance]
  for (const [key, label] of fields) {
    const value = data[key]
    if (typeof value !== 'string' || !value.trim()) continue
    const text = value.trim().replace(/\{\{(char|user)\}\}/gi, (_, key: string) => {
      return key.toLowerCase() === 'char' ? name : '聊天对象'
    })
    // Skip the whole field so nested or multiline unsupported macros cannot leak partial template text.
    if (templateDelimiter.test(text)) continue
    prompt.push(`${label}：${text}`)
  }
  const result = prompt.join('\n')
  if (result.length > maxPromptChars) throw new Error('BOT_PERSONA_FILE 的角色提示超过 8192 个字符，请缩短描述或对话示例。')
  return result
}
