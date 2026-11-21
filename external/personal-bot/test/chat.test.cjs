require('esbuild-register')
const assert = require('node:assert/strict')
const { beforeEach, afterEach, test } = require('node:test')
const { chat } = require('../src/chat.ts')
const { listModels, modelConfig } = require('../src/models.ts')

const envNames = ['AI_PROVIDER', 'AI_MODEL', 'AI_BASE_URL', 'AI_API_KEY', 'AI_KEY_ENV', 'AI_PRESETS', 'GEMINI_API_KEY', 'XAI_API_KEY', 'OPENAI_API_KEY']
const originalEnv = Object.fromEntries(envNames.map(key => [key, process.env[key]]))
const realFetch = global.fetch
const history = [{ role: 'user', content: '你好' }, { role: 'assistant', content: '在呢' }]

beforeEach(() => {
  Object.assign(process.env, {
    AI_PROVIDER: 'gemini', AI_MODEL: 'sample-model', GEMINI_API_KEY: 'gemini-key',
    XAI_API_KEY: 'grok-key', OPENAI_API_KEY: 'openai-key', AI_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta',
    AI_API_KEY: '', AI_KEY_ENV: '', AI_PRESETS: '',
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
    process.env.AI_BASE_URL = 'https://' + host + '/v1'
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

test('custom base URLs retain the gateway prefix for native Gemini and Responses', async () => {
  process.env.AI_BASE_URL = 'https://gateway.example/proxy/v2/'
  for (const [provider, path] of [['gemini', 'models/sample-model:generateContent'], ['grok', 'responses']]) {
    process.env.AI_PROVIDER = provider
    let sent
    global.fetch = async (url) => {
      sent = String(url)
      return Response.json(provider === 'gemini'
        ? { candidates: [{ content: { parts: [{ text: 'ok' }] } }] }
        : { output: [{ role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] })
    }
    assert.equal(await chat('s', [], 'x'), 'ok')
    assert.equal(sent, 'https://gateway.example/proxy/v2/' + path)
  }
})

test('Grok keeps its configured spelling and accepts old lowercase choices', async () => {
  process.env.AI_PROVIDER = 'Grok'
  process.env.AI_MODEL = 'Example-Model'
  const config = modelConfig({ name: 'grok' })
  assert.equal(config.name, 'Grok')
  assert.equal(config.provider, 'Grok')
  assert.equal(config.model, 'Example-Model')
  assert.equal(config.key, 'grok-key')
  assert.match(listModels(), /^Grok（Example-Model）/)
  assert.equal(modelConfig({ name: 'GROK' }).name, 'Grok')
})

test('mixed-case preset names and protocols resolve consistently from defaults and commands', async () => {
  const preset = { provider: 'Gemini', model: 'Sample', baseUrl: 'https://gateway.example/v1', keyEnv: 'GEMINI_API_KEY' }
  process.env.AI_PRESETS = JSON.stringify({ MyBot: preset })
  process.env.AI_PROVIDER = 'mybot'
  assert.equal(modelConfig().name, 'MyBot')
  let sent
  global.fetch = async (url, options) => {
    sent = new Request(url, options)
    return Response.json({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] })
  }
  assert.equal(await chat('s', [], 'hi', modelConfig({ name: 'MYBOT' })), 'ok')
  assert.equal(sent.url, 'https://gateway.example/v1/models/Sample:generateContent')
  assert.equal(sent.headers.get('x-goog-api-key'), 'gemini-key')
  process.env.AI_PRESETS = JSON.stringify({ MyBot: preset, mybot: preset })
  assert.throws(() => modelConfig(), /AI_PRESETS/)
})

test('Chat Completions sends gateway credentials, routed model ID and ordered history', async () => {
  Object.assign(process.env, {
    AI_PROVIDER: 'openai-compatible', AI_MODEL: 'vendor/grok-test',
    AI_BASE_URL: 'https://gateway.example/openai/v1', AI_API_KEY: 'gateway-only',
  })
  let sent
  global.fetch = async (url, options) => {
    sent = new Request(url, options)
    return Response.json({ choices: [{ message: { role: 'assistant', content: '收到', reasoning_content: 'private' } }] })
  }
  assert.equal(await chat('人设', history, '早安'), '收到')
  assert.equal(sent.url, 'https://gateway.example/openai/v1/chat/completions')
  assert.equal(sent.headers.get('authorization'), 'Bearer gateway-only')
  assert.equal(sent.headers.get('x-goog-api-key'), null)
  assert.equal(sent.redirect, 'error')
  assert.deepEqual(await sent.json(), {
    model: 'vendor/grok-test', messages: [{ role: 'system', content: '人设' }, ...history, { role: 'user', content: '早安' }],
    max_tokens: 2048,
  })
})

test('incomplete gateway configuration fails locally without disclosing its URL or using another key', async () => {
  Object.assign(process.env, { AI_PROVIDER: 'openai-compatible', AI_API_KEY: 'gateway-only' })
  for (const base of ['', 'bad-url', 'file:///tmp', 'https://user:secret@example.com', 'https://example.com/?key=secret', 'https://example.com/#secret']) {
    process.env.AI_BASE_URL = base
    await assert.rejects(chat('s', [], 'hi'), e => e.message.includes('AI_BASE_URL') && !e.message.includes('secret'))
  }
  process.env.AI_BASE_URL = 'https://example.com'
  delete process.env.AI_API_KEY
  await assert.rejects(chat('s', [], 'hi'), /AI_API_KEY/)
})

test('only configured services can be listed or selected, even if unrelated credentials exist', () => {
  delete process.env.AI_PROVIDER
  assert.match(listModels(), /尚未配置/)
  assert.throws(() => modelConfig({ name: 'openai', model: 'sample' }), /未知/)
  process.env.AI_PRESETS = JSON.stringify({
    bedrock: { provider: 'openai-compatible', model: 'vendor/model', baseUrl: 'https://gateway.example/v1', keyEnv: 'AI_API_KEY' },
    gemini: { provider: 'gemini', model: 'gem-test', baseUrl: 'https://proxy.example/v2', keyEnv: 'GEMINI_API_KEY' },
  })
  process.env.AI_API_KEY = 'gateway-only'
  process.env.AI_PROVIDER = 'bedrock'
  assert.equal(modelConfig().base, 'https://gateway.example/v1')
  assert.equal(modelConfig().key, 'gateway-only')
  const native = modelConfig({ name: 'gemini', model: 'custom' })
  assert.equal(native.base, 'https://proxy.example/v2')
  assert.equal(native.key, 'gemini-key')
  assert.equal(native.model, 'custom')
  assert.match(listModels(), /bedrock/)
  assert.doesNotMatch(listModels(), /grok|openai/)
  delete process.env.AI_PRESETS
  process.env.AI_PROVIDER = 'gemini'
  process.env.AI_KEY_ENV = 'AI_API_KEY'
  assert.equal(modelConfig().key, 'gateway-only')
  delete process.env.AI_BASE_URL
  assert.throws(() => modelConfig(), /AI_BASE_URL/)
})

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

test('unfamiliar memes with no usable search results ask for context', async () => {
  for (const [phrase, response, expectedSearches] of [
    ['草莓门', () => Response.json({ results: [] }), 1],
    ['草莓门', () => new Response(null, { status: 429 }), 1],
    ['其他会话的词', undefined, 0],
    ['1234567890', undefined, 0],
  ]) {
    let searches = 0
    let modelCalls = 0
    global.fetch = async url => {
      if (String(url) === 'https://api.tavily.com/search') {
        searches++
        return response()
      }
      modelCalls++
      return Response.json({ candidates: [{ content: { parts: [modelCalls === 1
        ? { functionCall: { name: 'research_meme', args: { phrase, focus: '含义' } } }
        : { text: '证据不足' }] } }] })
    }
    const reply = await chat('卡比', [], '草莓门 1234567890', modelConfig(), { key: 'test-key',
      acquire: () => () => {}, chargeFollowup() {} })
    assert.match(reply, /上文/)
    assert.equal(searches, expectedSearches)
    assert.equal(modelCalls, 1 + expectedSearches)
  }
})

for (const protocol of ['gemini', 'openai-compatible']) {
  test(protocol + ' sends the matching native tool result and retains provider call metadata', async () => {
    const requests = []
    let charges = 0
    const config = { ...modelConfig(), protocol }
    global.fetch = async (url, options) => {
      if (String(url).includes('api.tavily.com')) return Response.json({ results: [{ content: '草莓入队' }] })
      const body = JSON.parse(options.body)
      requests.push(body)
      const args = { phrase: '草莓门', focus: '含义' }
      if (protocol === 'gemini') {
        const part = requests.length === 1 ? { thoughtSignature: 'sig', functionCall: { id: 'id', name: 'research_meme', args } }
          : { text: requests.length === 2 ? '举草莓' : '我也入队' }
        return Response.json({ candidates: [{ content: { parts: [part] } }] })
      }
      const message = requests.length === 1 ? { role: 'assistant', reasoning_content: 'sig', tool_calls: [
        { id: 'id', type: 'function', function: { name: 'research_meme', arguments: JSON.stringify(args) } },
      ] } : { content: requests.length === 2 ? '举草莓' : '我也入队' }
      return Response.json({ choices: [{ message }] })
    }
    assert.equal(await chat('卡比', [], '草莓门', config, { key: 'search', acquire: () => () => {}, chargeFollowup() { charges++ } }), '我也入队')
    assert.equal(charges, 2)
    if (protocol === 'gemini') {
      assert.equal(requests[0].tools[0].functionDeclarations[0].name, 'research_meme')
      assert.equal(requests[2].toolConfig.functionCallingConfig.mode, 'NONE')
      assert.equal(requests[2].contents.at(-2).parts[0].thoughtSignature, 'sig')
      assert.equal(requests[2].contents.at(-1).parts[0].functionResponse.id, 'id')
    } else {
      assert.equal(requests[0].tools[0].function.name, 'research_meme')
      assert.equal(requests[2].tool_choice, 'none')
      assert.equal(requests[2].messages.at(-2).reasoning_content, 'sig')
      assert.equal(requests[2].messages.at(-1).tool_call_id, 'id')
    }
  })
}

test('gateways rejecting a tool-enabled request can still reply through normal chat', async () => {
  let charges = 0
  const bodies = []
  global.fetch = async (_, options) => {
    const body = JSON.parse(options.body)
    bodies.push(body)
    if (body.tools) return new Response(null, { status: 400 })
    return Response.json({ candidates: [{ content: { parts: [{ text: '在呢' }] } }] })
  }
  const reply = await chat('卡比', [], '你好', modelConfig(), { key: 'key', acquire: () => assert.fail(), chargeFollowup() { charges++ } })
  assert.equal(reply, '在呢')
  assert.equal(charges, 1)
  assert.equal(bodies.length, 2)
})
