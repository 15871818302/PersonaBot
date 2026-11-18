require('esbuild-register')
const assert = require('node:assert/strict')
const { beforeEach, afterEach, test } = require('node:test')
const { chat } = require('../src/chat.ts')

const envNames = ['AI_PROVIDER', 'AI_MODEL', 'GEMINI_API_KEY', 'XAI_API_KEY', 'OPENAI_API_KEY']
const originalEnv = Object.fromEntries(envNames.map(key => [key, process.env[key]]))
const realFetch = global.fetch
const history = [{ role: 'user', content: '你好' }, { role: 'assistant', content: '在呢' }]

beforeEach(() => {
  Object.assign(process.env, {
    AI_PROVIDER: 'gemini', AI_MODEL: 'sample-model', GEMINI_API_KEY: 'gemini-key',
    XAI_API_KEY: 'grok-key', OPENAI_API_KEY: 'openai-key',
  })
  global.fetch = () => assert.fail('unexpected fetch')
})
afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  global.fetch = realFetch
})

test('Gemini receives system instructions and ordered history and returns visible text', async () => {
  let request
  global.fetch = async (url, options) => {
    request = new Request(url, options)
    return Response.json({ candidates: [{ content: { parts: [
      { thought: true, text: 'private' }, { text: '早' }, { text: '上好' },
    ] } }] })
  }
  assert.equal(await chat('人设', history, '早安'), '早上好')
  assert.equal(request.url, 'https://generativelanguage.googleapis.com/v1beta/models/sample-model:generateContent')
  assert.equal(request.redirect, 'error')
  assert.equal(request.headers.get('x-goog-api-key'), 'gemini-key')
  assert.equal(request.headers.get('authorization'), null)
  const body = await request.json()
  assert.deepEqual(body.systemInstruction.parts, [{ text: '人设' }])
  assert.deepEqual(body.contents.map(x => [x.role, x.parts[0].text]), [
    ['user', '你好'], ['model', '在呢'], ['user', '早安'],
  ])
  assert.equal(body.generationConfig.maxOutputTokens, 2048)
  assert.equal(body.tools, undefined)
})

for (const [provider, host, token] of [
  ['grok', 'api.x.ai', 'grok-key'], ['openai', 'api.openai.com', 'openai-key'],
]) {
  test(provider + ' uses its own Responses endpoint, key, and explicit history', async () => {
    process.env.AI_PROVIDER = provider
    let request
    global.fetch = async (url, options) => {
      request = new Request(url, options)
      return Response.json({ output: [
        { type: 'reasoning', content: [{ type: 'output_text', text: 'private' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '收到' }] },
      ] })
    }
    assert.equal(await chat('人设', history, '早安'), '收到')
    assert.equal(request.url, 'https://' + host + '/v1/responses')
    assert.equal(request.headers.get('authorization'), 'Bearer ' + token)
    assert.equal(request.redirect, 'error')
    const body = await request.json()
    assert.equal(body.model, 'sample-model')
    assert.deepEqual(body.input, [{ role: 'system', content: '人设' }, ...history, { role: 'user', content: '早安' }])
    assert.equal(body.store, false)
    assert.equal(body.tools, undefined)
    assert.equal(body.max_output_tokens, 2048)
  })
}

test('invalid config and oversized inputs fail before any request', async () => {
  let calls = 0
  global.fetch = () => { calls++; throw new Error('unexpected') }
  await assert.rejects(chat('s', [], 'x'.repeat(4097)))
  await assert.rejects(chat('s'.repeat(8193), [], 'x'))
  for (const name of ['AI_PROVIDER', 'AI_MODEL', 'GEMINI_API_KEY']) {
    const previous = process.env[name]
    delete process.env[name]
    await assert.rejects(chat('s', [], 'x'), new RegExp(name))
    process.env[name] = previous
  }
  process.env.AI_MODEL = '../some?key=secret'
  await assert.rejects(chat('s', [], 'x'), /AI_MODEL/)
  assert.equal(calls, 0)
})

test('bounds replayed history, visible reply and received bytes', async () => {
  let sent
  global.fetch = async (_url, options) => {
    sent = JSON.parse(options.body)
    return Response.json({ candidates: [{ content: { parts: [{ text: '答'.repeat(9000) }] } }] })
  }
  const messages = Array.from({ length: 14 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: String(i) + 'x'.repeat(9000) }))
  assert.equal((await chat('s', messages, 'hi')).length, 2000)
  assert.equal(sent.contents.length, 13)
  assert.equal(sent.contents[0].parts[0].text.length, 2048)
  assert.match(sent.contents[0].parts[0].text, /^2x/)
  global.fetch = async () => Response.json({ candidates: [{ content: { parts: [{ text: 'x'.repeat(300000) }] } }] })
  await assert.rejects(chat('s', [], 'hi'))
})

test('provider and transport failures expose only local messages', async () => {
  for (const fail of [
    () => new Response('secret echoed prompt', { status: 429 }),
    () => new Response('secret invalid JSON'), () => { throw new Error('secret key') },
    () => Response.json({ error: { message: 'secret key' } }),
  ]) {
    global.fetch = fail
    await assert.rejects(chat('s', [], 'hi'), error => !error.message.includes('secret') && !error.cause)
  }
})

test('aborts a stalled request after the configured deadline', async t => {
  let duration
  t.mock.method(global, 'setTimeout', (callback, milliseconds) => {
    duration = milliseconds
    queueMicrotask(callback)
  })
  global.fetch = async (_url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  await assert.rejects(chat('s', [], 'hi'), /超时/)
  assert.equal(duration, 30_000)
})
