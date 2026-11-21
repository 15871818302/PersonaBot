const { test } = require('node:test')
const assert = require('node:assert/strict')
const { apply } = require('../src/index.ts')

function commands(users = '', groups = '', baseDir) {
  process.env.BOT_ALLOWED_USERS = users
  process.env.BOT_ALLOWED_GROUPS = groups
  const handlers = {}
  apply({
    baseDir, setInterval() {}, i18n: { define() {} },
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

test('chat returns the model answer without a preliminary message', async t => {
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
  assert.match(await bot.ai({ session: sender }, '再试一次'), /喘口气/)
  assert.deepEqual(events, ['model request'])
})

test('spoken queries use the existing services and keep parcel lookups private', async t => {
  const urls = []
  t.mock.method(global, 'fetch', async url => {
    urls.push(String(url))
    return Response.json({ results: [] })
  })
  const bot = commands('qq:alice', 'qq:g')
  const reply = await bot.onMessage({ ...group, stripped: { atSelf: true, content: '杭州今天天气怎么样？' } }, () => 'pass')
  assert.match(String(reply), /未找到这个城市/)
  assert.equal(new URL(urls[0]).searchParams.get('name'), '杭州')
  assert.match(String(await bot.ai({ session: group }, '查快递 韵达 12345678')), /私聊/)
  assert.match(String(await commands('qq:alice').ai({ session }, '查快递 顺丰 SF12345678')), /手机号/)
  assert.equal(urls.length, 1)
})

test('weather and a place anywhere in visible text trigger in authorized DMs and unaddressed groups', async t => {
  const names = []
  t.mock.method(global, 'fetch', async url => {
    names.push(new URL(url).searchParams.get('name'))
    return Response.json({ results: [] })
  })
  async function receive(who, content) {
    return commands('qq:alice', 'qq:g').onMessage({ ...who, stripped: { content, atSelf: false } }, () => 'pass')
  }
  for (const [who, message] of [[session, '说起天气，我刚从杭州回来'], [group, '长沙县那边，天气还好吗？<face id="1"/>']]) {
    assert.match(String(await receive(who, message)), /未找到这个城市/)
  }
  for (const message of ['今天天气怎么样？', '我们去杭州玩吧', '天气<at id="杭州"/>']) {
    assert.equal(await receive(group, message), 'pass')
  }
  assert.equal(await receive({ ...group, userId: 'other' }, '杭州天气'), 'pass')
  assert.deepEqual(names, ['杭州', '长沙县'])
})

test('closed by default; user, platform and group must match; parcel requires direct messages', async () => {
  assert.match(await commands().ai({ session }, 'hi'), /许可/)
  const bot = commands('qq:alice', 'qq:g')
  assert.match(await bot.weather({ session: { ...session, platform: 'other' } }, '北京'), /许可/)
  assert.match(await bot.ai({ session: { ...group, guildId: 'other' } }, 'hi'), /许可/)
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
  assert.match(await bot.forget({ session }), /这次的聊天记录清掉/)
  await send(session, '重来')
  assert.equal(inputs.at(-1).length, 2)
  await bot.ai({ session }, '第一条')
  assert.match(await bot.ai({ session }, '第二条'), /喘口气/)
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

test('a follow-up delegates the earlier meme and keeps private conversation out of the worker', async t => {
  const oldKey = process.env.TAVILY_API_KEY
  t.after(() => {
    if (oldKey === undefined) delete process.env.TAVILY_API_KEY
    else process.env.TAVILY_API_KEY = oldKey
  })
  Object.assign(process.env, { AI_PROVIDER: 'openai', AI_MODEL: 'test', AI_BASE_URL: 'https://default.example/v1',
    OPENAI_API_KEY: 'test-only', BOT_PERSONA_FILE: '', TAVILY_API_KEY: 'test-search' })
  const requests = []
  const searches = []
  t.mock.method(global, 'fetch', async (url, options) => {
    const body = JSON.parse(options.body)
    if (String(url) === 'https://api.tavily.com/search') {
      searches.push(body.query)
      return Response.json({ results: [{ url: 'https://example.org/meme', content: '举起草莓就是加入队伍。' }] })
    }
    requests.push(body)
    function call(name, args) {
      return Response.json({ output: [{ type: 'function_call', name, arguments: JSON.stringify(args), call_id: 'call-' + name }] })
    }
    if (requests.length === 2) return call('research_meme', { phrase: '草莓门', focus: '近期用法' })
    if (requests.length === 3) return call('refine_search', { keywords: '草莓入队' })
    const text = ['在呢', '', '', '查到了举草莓入队的用法。', '举草莓入队！', '在呢'][requests.length - 1]
    return Response.json({ output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] })
  })
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const bot = commands('qq:alice', 'qq:g')
  const receive = content => bot.onMessage({ ...group, stripped: { atSelf: true, content } }, () => 'pass')
  await receive('我同事小王发了个草莓门。')
  now += 6000
  assert.equal(String(await receive('这句最近怎么又火了？')), '举草莓入队！')
  assert.equal(requests[1].tools[0].name, 'research_meme')
  assert.equal(requests[2].tools[0].name, 'refine_search')
  assert.doesNotMatch(JSON.stringify([searches, requests[2], requests[3]]), /小王/)
  assert.match(JSON.stringify(requests[3].input.at(-1)), /举起草莓/)
  assert.equal(requests[4].input.at(-1).call_id, 'call-research_meme')
  assert.match(requests[4].input.at(-1).output, /example.org/)
  assert.equal(searches.length, 2)
  assert.match(searches[1], /草莓入队/)
  now += 6000
  await receive('还有呢？')
  assert.deepEqual(requests.at(-1).input.slice(1).map(item => item.content),
    ['我同事小王发了个草莓门。', '在呢', '这句最近怎么又火了？', '举草莓入队！', '还有呢？'])
})

test('addressed group chats understand an explicit same-channel quote', async t => {
  Object.assign(process.env, { AI_PROVIDER: 'openai', AI_MODEL: 'test', AI_BASE_URL: 'https://default.example/v1',
    OPENAI_API_KEY: 'test-only', BOT_PERSONA_FILE: '' })
  const messages = []
  t.mock.method(global, 'fetch', async (_, options) => {
    messages.push(JSON.parse(options.body).input.at(-1).content)
    return Response.json({ output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '好' }] }] })
  })
  const bot = commands('qq:alice,qq:bob', 'qq:g')
  for (const [userId, channel] of [['alice', 'c'], ['bob', 'other']]) {
    await bot.onMessage({ ...group, userId, quote: { channel: { id: channel }, content: '草莓门<at id="private"/>' },
      stripped: { atSelf: true, content: '这句啥意思？' } }, () => 'pass')
  }
  assert.match(messages[0], /草莓门/)
  assert.match(messages[0], /这句啥意思/)
  assert.doesNotMatch(messages[0], /private/)
  assert.equal(messages[1], '这句啥意思？')
})

test('overlapping group chats cap researchers and release both slots after timeout', { timeout: 4000 }, async t => {
  const oldKey = process.env.TAVILY_API_KEY
  t.after(() => {
    if (oldKey === undefined) delete process.env.TAVILY_API_KEY
    else process.env.TAVILY_API_KEY = oldKey
  })
  Object.assign(process.env, { AI_PROVIDER: 'openai', AI_MODEL: 'test', AI_BASE_URL: 'https://default.example/v1',
    OPENAI_API_KEY: 'test-only', BOT_PERSONA_FILE: '', TAVILY_API_KEY: 'test-search' })
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const deadlines = []
  const timeout = AbortSignal.timeout.bind(AbortSignal)
  t.mock.method(AbortSignal, 'timeout', duration => {
    if (duration !== 60000) return timeout(duration)
    const controller = new AbortController()
    deadlines.push(controller)
    return controller.signal
  })
  let twoStarted
  const started = new Promise(resolve => { twoStarted = resolve })
  let thirdStarted
  const third = new Promise(resolve => { thirdStarted = resolve })
  let finishThird
  let searchCount = 0
  t.mock.method(global, 'fetch', async (url, options) => {
    if (String(url).includes('api.tavily.com')) {
      if (++searchCount === 2) twoStarted()
      return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }))
    }
    const body = JSON.parse(options.body)
    const last = body.input.at(-1).content
    if (last === '你好') {
      thirdStarted()
      await new Promise(resolve => { finishThird = resolve })
      return Response.json({ output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '在呢' }] }] })
    }
    return Response.json({ output: [{ type: 'function_call', call_id: 'call', name: 'research_meme',
      arguments: JSON.stringify({ phrase: '草莓门', focus: '含义' }) }] })
  })
  const bot = commands('qq:a,qq:b,qq:c,qq:d', 'qq:g')
  const send = (userId, message = '草莓门') => bot.ai({ session: { ...group, userId } }, message)
  const a = send('a'), b = send('b')
  await started
  assert.match(String(await send('a')), /喘口气/)
  assert.match(String(await send('c')), /查梗的人有点多/)
  now += 6000
  const ordinary = send('c', '你好')
  await third
  assert.match(String(await send('d')), /喘口气/)
  assert.equal(searchCount, 2)
  finishThird()
  assert.equal(String(await ordinary), '在呢')
  deadlines[0].abort()
  deadlines[1].abort()
  for (const reply of await Promise.all([a, b])) assert.match(String(reply), /超时/)
  now += 6000
  const retried = send('a')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(searchCount, 3)
  deadlines.at(-1).abort()
  assert.match(String(await retried), /超时/)
})

test('Kirby explains chat limits and parcel privacy in character without a network request', async t => {
  const previous = process.env.BOT_PERSONA_FILE
  t.after(() => {
    if (previous === undefined) delete process.env.BOT_PERSONA_FILE
    else process.env.BOT_PERSONA_FILE = previous
  })
  delete process.env.BOT_PERSONA_FILE
  t.mock.method(global, 'fetch', () => assert.fail('offline command made a network request'))
  const bot = commands('qq:alice')
  assert.match(await bot.ping(), /噗哟.*pong/)
  assert.match(await bot.weather({ session }), /我.*天气 北京/)
  assert.match(await bot.ai({ session: { ...session, userId: 'stranger' } }, '你好'), /我.*许可.*主人/)
  assert.match(await bot.ai({ session }, '字'.repeat(4097)), /一口吞不下.*4096 个字符/)
  assert.match(await bot.ai({ session }, '<image src="example"/>'), /我.*文字.*告诉我/)
  assert.match(await bot.parcel({ session: group }, '韵达', '12345678'), /收好.*私聊/)
  assert.match(await bot.ai({ session }, '查快递'), /我.*快递 韵达 运单号/)
  process.env.BOT_PERSONA_FILE = require('node:path').join(__dirname, '../examples/qq-assistant.json')
  assert.doesNotMatch(await commands('qq:alice').ping(), /噗哟|卡比/)
})
