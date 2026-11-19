const { test } = require('node:test')
const assert = require('node:assert/strict')
const { apply } = require('../src/index.ts')

function commands(users = '', groups = '', baseDir) {
  process.env.BOT_ALLOWED_USERS = users
  process.env.BOT_ALLOWED_GROUPS = groups
  const handlers = {}
  apply({
    baseDir, setInterval() {},
    middleware(fn) { handlers.onMessage = fn },
    command(declaration) {
      return { alias() { return this }, action(fn) { handlers[declaration.split(' ')[0]] = fn } }
    },
  })
  return handlers
}
const session = { selfId: 'bot', userId: 'alice', channelId: 'c', platform: 'qq', isDirect: true, async send() { return [] } }
const group = { ...session, isDirect: false, guildId: 'g' }

test('plain text chats in authorized DMs and addressed groups', async t => {
  Object.assign(process.env, { AI_PROVIDER: 'openai', AI_MODEL: 'test', AI_BASE_URL: 'https://default.example/v1', OPENAI_API_KEY: 'test-only', BOT_PERSONA_FILE: '' })
  const inputs = []
  t.mock.method(global, 'fetch', async (_, request) => {
    inputs.push(JSON.parse(request.body).input.at(-1).content)
    return Response.json({ output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '你好！' }] }] })
  })
  const bot = commands('qq:alice,qq:bob', 'qq:g')
  async function receive(who, content, atSelf = false) {
    return bot.onMessage({ ...who, stripped: { content, atSelf } }, () => 'pass')
  }
  assert.equal(await receive(group, '群友之间的对话'), 'pass')
  assert.equal(await receive({ ...group, guildId: 'other' }, '你好', true), 'pass')
  assert.equal(await receive({ ...session, userId: 'eve' }, '你好'), 'pass')
  assert.equal(await receive(session, ''), 'pass')
  assert.equal(String(await receive(session, '你好 &lt;朋友&gt;')), '你好！')
  assert.equal(String(await receive({ ...group, userId: 'bob' }, '今天过得好吗？', true)), '你好！')
  assert.deepEqual(inputs, ['你好 <朋友>', '今天过得好吗？'])
})

test('chat sends a Kirby thinking message before contacting the model', async t => {
  Object.assign(process.env, { AI_PROVIDER: 'openai', AI_MODEL: 'test', AI_BASE_URL: 'https://default.example/v1', OPENAI_API_KEY: 'test-only', BOT_PERSONA_FILE: '' })
  const events = []
  const sender = { ...session, async send(message) { events.push(String(message)); return ['sent'] } }
  t.mock.method(global, 'fetch', async () => {
    events.push('model request')
    return Response.json({ output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] }] })
  })
  const bot = commands('qq:alice')
  await bot.ai({ session: { ...sender, userId: 'stranger' } }, '你好')
  await bot.ai({ session: sender }, '')
  assert.deepEqual(events, [])
  const reply = await bot.ai({ session: sender }, '只回复OK')
  assert.equal(String(reply), 'OK')
  assert.match(await bot.ai({ session: sender }, '再试一次'), /频繁/)
  assert.deepEqual(events, ['噗哟～让我想一想！', 'model request'])
})

test('closed by default; user, platform and group must match; parcel requires direct messages', async () => {
  assert.match(await commands().ai({ session }, 'hi'), /未获授权/)
  const bot = commands('qq:alice', 'qq:g')
  assert.match(await bot.weather({ session: { ...session, platform: 'other' } }, '北京'), /未获授权/)
  assert.match(await bot.ai({ session: { ...group, guildId: 'other' } }, 'hi'), /未获授权/)
  assert.match(await bot.parcel({ session: group }, '韵达', '12345678'), /私聊/)
  assert.match(await bot.parcel({ session: { ...session, userId: 'eve' } }, '韵达', '12345678'), /私聊/)
})

test('chat escapes message markup, rate-limits calls, isolates history and forgets it', async (t) => {
  Object.assign(process.env, { AI_PROVIDER: 'openai', AI_MODEL: 'test', AI_BASE_URL: 'https://default.example/v1', OPENAI_API_KEY: 'test-only', BOT_PERSONA_FILE: '' })
  const inputs = []
  t.mock.method(global, 'fetch', async (_, request) => {
    inputs.push(JSON.parse(request.body).input)
    return Response.json({ output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '<at type="all"/>' }] }] })
  })
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const bot = commands('qq:alice,qq:bob', 'qq:g')
  async function send(who, text) {
    const reply = await bot.ai({ session: who }, text)
    now += 5100
    return reply
  }
  assert.equal((await send(session, '私聊消息')).type, 'text')
  assert.equal(String(await send(group, '群内消息')).includes('<at'), false)
  await send({ ...group, userId: 'bob' }, '另一个人')
  await send(session, '继续')
  assert.deepEqual(inputs.map(x => x.length), [2, 2, 2, 4])
  assert.equal(inputs[3][1].content, '私聊消息')
  assert.match(await bot.forget({ session }), /已清除/)
  await send(session, '重来')
  assert.equal(inputs.at(-1).length, 2)
  await bot.ai({ session }, '第一条')
  assert.match(await bot.ai({ session }, '第二条'), /频繁/)
  assert.equal(inputs.length, 6)
})

test('only the owner manages persistent personal model choices and histories stay with their API', async t => {
  const fs = require('node:fs')
  const root = fs.mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'qq-models-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  Object.assign(process.env, {
    BOT_OWNER_ID: 'qq:alice', AI_PROVIDER: 'openai', AI_MODEL: 'default-model',
    AI_BASE_URL: 'https://default.example/v1', OPENAI_API_KEY: 'default-only',
    GEMINI_API_KEY: 'gem-only', TEST_GATEWAY_KEY: 'gateway-only',
    AI_PRESETS: JSON.stringify({ lab: { provider: 'openai-compatible', model: 'vendor/sample',
      baseUrl: 'https://lab.example/api/v1', keyEnv: 'TEST_GATEWAY_KEY' },
      gemini: { provider: 'gemini', baseUrl: 'https://gemini.example/v1', model: 'gem-test', keyEnv: 'GEMINI_API_KEY' } }),
  })
  const start = () => commands('qq:alice,qq:bob,other:alice', 'qq:g', root)
  let bot = start()
  const owner = { session }
  const bob = { session: { ...session, userId: 'bob', authority: 5 } }
  const calls = []
  t.mock.method(global, 'fetch', async (url, options) => {
    const body = JSON.parse(options.body)
    calls.push({ url, body, headers: options.headers })
    return Response.json({ choices: [{ message: { content: 'ok' } }], output: [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] },
    ] })
  })
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  for (const who of [bob, { session: { ...session, platform: 'other' } }]) {
    assert.match(String(await bot['model-switch'](who, 'lab')), /本人/)
    assert.match(String(await bot['model-list'](who)), /本人/)
    assert.match(String(await bot['model-current'](who)), /本人/)
  }
  assert.match(String(await bot['model-list'](owner)), /lab/)
  assert.match(String(await bot['model-current'](owner)), /default-model/)
  await bot.ai(owner, 'first')
  now += 6000
  const switched = String(await bot['model-switch'](owner, 'lab'))
  assert.match(switched, /vendor\/sample/)
  assert.doesNotMatch(switched, /gateway-only/)
  await bot.ai(owner, 'second')
  assert.equal(calls[1].url, 'https://lab.example/api/v1/chat/completions')
  assert.deepEqual(calls[1].body.messages.map(x => x.role), ['system', 'user'])
  assert.equal(calls[1].headers.Authorization, 'Bearer gateway-only')
  assert.match(String(await bot['model-switch'](owner, 'missing', 'x')), /未知/)
  bot = start()
  assert.match(String(await bot['model-current'](owner)), /vendor\/sample/)
  await bot.ai(bob, 'hi')
  assert.equal(calls[2].body.model, 'default-model')
  assert.match(String(await bot['model-switch'](owner, 'gemini', 'gem-test')), /gem-test/)
  assert.match(String(await bot['model-switch'](owner, '默认')), /默认/)
  assert.match(String(await start()['model-current'](owner)), /default-model/)
  const file = fs.readdirSync(root + '/data/model-preferences')
  assert.equal(file.length, 0)
  delete process.env.BOT_OWNER_ID
  assert.match(String(await start()['model-switch'](owner, 'lab')), /本人/)
})
