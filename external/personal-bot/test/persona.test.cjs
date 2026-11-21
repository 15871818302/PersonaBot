const assert = require('node:assert/strict')
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const test = require('node:test')
const { loadPersona } = require('../src/persona.ts')

function setCard(t, path) {
  const previous = process.env.BOT_PERSONA_FILE
  if (path === undefined) delete process.env.BOT_PERSONA_FILE
  else process.env.BOT_PERSONA_FILE = path
  t.after(() => {
    if (previous === undefined) delete process.env.BOT_PERSONA_FILE
    else process.env.BOT_PERSONA_FILE = previous
  })
}

function temporaryCard(t, contents) {
  const directory = mkdtempSync(join(tmpdir(), 'qq-persona-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'card.json')
  writeFileSync(path, contents)
  setCard(t, path)
}

test('loads the bundled Kirby card when no external card is configured', t => {
  setCard(t, undefined)
  const prompt = loadPersona()
  assert.match(prompt, /^你是卡比。/)
  assert.match(prompt, /复制能力/)
  assert.doesNotMatch(prompt, /天气 杭州/)
  assert.doesNotMatch(prompt, /\{\{/)
})

test('imports the sample exported card and expands its character and user names', t => {
  setCard(t, join(__dirname, '../examples/qq-assistant.json'))
  const prompt = loadPersona()
  assert.match(prompt, /阿栗/)
  assert.match(prompt, /聊天对象/)
  assert.doesNotMatch(prompt, /\{\{/)
})

test('imports only supported fields and discards definitions containing unknown macros', t => {
  temporaryCard(t, JSON.stringify({
    spec: 'chara_card_v2', spec_version: '2.0',
    data: {
      name: '阿栗', description: '{{CHAR}}陪{{user}}聊天。',
      personality: '{{random::SECRET::ALSO_SECRET}}',
      scenario: '<% print("TEMPLATE_OVERRIDE") %>',
      first_mes: '{% if private %}TEMPLATE_OVERRIDE{% endif %}',
      system_prompt: 'SYSTEM_OVERRIDE', post_history_instructions: 'HISTORY_OVERRIDE',
      extensions: { depth_prompt: { prompt: 'DEPTH_OVERRIDE' } },
      character_book: { entries: [{ content: 'LORE_OVERRIDE' }] },
    },
  }))
  const prompt = loadPersona()
  assert.match(prompt, /阿栗陪聊天对象聊天。/)
  assert.doesNotMatch(prompt, /SECRET|OVERRIDE|\{\{/)
})

test('rejects malformed configured cards without disclosing their text', t => {
  temporaryCard(t, 'SENSITIVE data')
  assert.throws(loadPersona, err => err.message.includes('BOT_PERSONA_FILE') && !err.message.includes('SENSITIVE'))
})

test('rejects a card that lacks a supported version or character name', t => {
  temporaryCard(t, JSON.stringify({ name: 'Wrong format' }))
  assert.throws(loadPersona, /BOT_PERSONA_FILE/)
})

test('rejects a rendered persona larger than the model client system prompt limit', t => {
  temporaryCard(t, JSON.stringify({
    spec: 'chara_card_v2', spec_version: '2.0',
    data: { name: '阿栗', description: '栗'.repeat(8192) },
  }))
  assert.throws(loadPersona, /8192/)
})
