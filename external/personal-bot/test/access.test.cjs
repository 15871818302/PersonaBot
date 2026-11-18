const { test } = require('node:test')
const assert = require('node:assert/strict')
const { apply } = require('../src/index.ts')

function commands(users = '', groups = '') {
  process.env.BOT_ALLOWED_USERS = users
  process.env.BOT_ALLOWED_GROUPS = groups
  const handlers = {}
  apply({
    setInterval() {},
    command(declaration) {
      return { alias() { return this }, action(fn) { handlers[declaration.split(' ')[0]] = fn } }
    },
  })
  return handlers
}
const session = { selfId: 'bot', userId: 'alice', channelId: 'c', platform: 'llonebot', isDirect: true }
const group = { ...session, isDirect: false, guildId: 'g' }

test('closed by default; user, platform and group must match; parcel requires direct messages', async () => {
  assert.match(await commands().ai({ session }, 'hi'), /未获授权/)
  const bot = commands('llonebot:alice', 'llonebot:g')
  assert.match(await bot.weather({ session: { ...session, platform: 'other' } }, '北京'), /未获授权/)
  assert.match(await bot.ai({ session: { ...group, guildId: 'other' } }, 'hi'), /未获授权/)
  assert.match(await bot.parcel({ session: group }, '韵达', '12345678'), /私聊/)
  assert.match(await bot.parcel({ session: { ...session, userId: 'eve' } }, '韵达', '12345678'), /私聊/)
})

test('chat escapes message markup, rate-limits calls, isolates history and forgets it', async (t) => {
  Object.assign(process.env, { AI_PROVIDER: 'openai', AI_MODEL: 'test', OPENAI_API_KEY: 'test-only', BOT_PERSONA_FILE: '' })
  const inputs = []
  t.mock.method(global, 'fetch', async (_, request) => {
    inputs.push(JSON.parse(request.body).input)
    return Response.json({ output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '<at type="all"/>' }] }] })
  })
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const bot = commands('llonebot:alice,llonebot:bob', 'llonebot:g')
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
