const { test, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { weather, track } = require('../src/queries.ts')

const originalFetch = global.fetch
const originalEnv = { ...process.env }
afterEach(() => {
  global.fetch = originalFetch
  for (const key of ['KUAIDI100_CUSTOMER', 'KUAIDI100_KEY']) {
    if (originalEnv[key] === undefined) delete process.env[key]
    else process.env[key] = originalEnv[key]
  }
})

test('Chinese city weather uses fixed hosts, current data and Beijing time', async () => {
  const urls = []
  global.fetch = async (input, options) => {
    const url = new URL(input)
    urls.push(url)
    assert.equal(options.redirect, 'error')
    assert.ok(options.signal instanceof AbortSignal)
    if (urls.length === 1) return Response.json({ results: [
      { country_code: 'CN', name: '杭州', admin1: '浙江', latitude: 30.2, longitude: 120.1 },
    ] })
    return Response.json({ current: { time: '2026-11-18T21:45', temperature_2m: 11.5, relative_humidity_2m: 82, weather_code: 3 } })
  }
  const result = await weather('杭州市')
  assert.match(result, /杭州/)
  assert.match(result, /11\.5/)
  assert.match(result, /82%/)
  assert.match(result, /阴/)
  assert.deepEqual(urls.map(u => u.origin + u.pathname), [
    'https://geocoding-api.open-meteo.com/v1/search', 'https://api.open-meteo.com/v1/forecast',
  ])
  assert.equal(urls[0].searchParams.get('name'), '杭州')
  assert.equal(urls[0].searchParams.get('countryCode'), 'CN')
  assert.equal(urls[1].searchParams.get('timezone'), 'Asia/Shanghai')
})

test('invalid inputs, missing credentials and phone-verified carriers make no requests', async () => {
  delete process.env.KUAIDI100_KEY
  let requests = 0
  global.fetch = async () => { requests++; throw new Error() }
  assert.match(await weather('https://example.org/'), /城市/)
  assert.match(await track('圆通', '!!!'), /单号/)
  assert.match(await track('韵达', 'YD12345678'), /配置/)
  assert.match(await track('顺丰', 'SF12345678'), /手机号/)
  assert.equal(requests, 0)
})

test('tracking signs the exact form payload, coalesces identical queries and returns only a status summary', async () => {
  process.env.KUAIDI100_CUSTOMER = 'test-customer'
  process.env.KUAIDI100_KEY = 'test-key'
  let count = 0
  global.fetch = async (input, options) => {
    count++
    assert.equal(String(input), 'https://poll.kuaidi100.com/poll/query.do')
    assert.equal(options.method, 'POST')
    assert.equal(options.redirect, 'error')
    assert.ok(options.signal instanceof AbortSignal)
    const form = new URLSearchParams(options.body)
    assert.equal(form.get('customer'), 'test-customer')
    const param = form.get('param')
    assert.equal(JSON.parse(param).num, 'YT12345678')
    assert.equal(JSON.parse(param).com, 'yuantong')
    assert.equal(form.get('sign'), createHash('md5').update(param + 'test-keytest-customer').digest('hex').toUpperCase())
    return Response.json({ status: '200', state: '3', com: 'yuantong', nu: 'YT12345678', data: [
      { ftime: '2026-11-18 19:00:00', context: 'private address or phone', location: 'private address' },
    ] })
  }
  const [first, second] = await Promise.all([track('圆通', 'YT12345678'), track('yuantong', 'YT12345678')])
  assert.match(first, /签收/)
  assert.match(first, /19:00/)
  assert.doesNotMatch(first, /private|YT12345678|test-key/)
  assert.equal(first, second)
  assert.equal(await track('圆通', 'YT12345678'), first)
  assert.equal(count, 1)
})

test('private provider errors and malformed data never reach chat', async () => {
  process.env.KUAIDI100_CUSTOMER = 'test-customer'
  process.env.KUAIDI100_KEY = 'test-key'
  global.fetch = async () => Response.json({ returnCode: '408', message: 'private diagnostic' })
  assert.doesNotMatch(await track('韵达', 'YD88888888'), /private|408/)
  global.fetch = async () => { throw new Error('private connection details') }
  assert.doesNotMatch(await weather('北京'), /private/)
  global.fetch = async () => Response.json({ results: [] })
  assert.match(await weather('北京'), /未找到/)
})

test('a mismatched waybill cannot supply another shipment’s status', async () => {
  process.env.KUAIDI100_CUSTOMER = 'test-customer'
  process.env.KUAIDI100_KEY = 'test-key'
  global.fetch = async () => Response.json({ status: '200', state: '3', com: 'yunda', nu: 'OTHER001',
    data: [{ ftime: '2026-11-18 19:00:00' }] })
  assert.match(await track('韵达', 'YD77777777'), /不可用/)
})

test('oversized responses cancel streaming and discard the content', async () => {
  let cancelled = false
  global.fetch = async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(64 * 1024)) },
    cancel() { cancelled = true },
  }))
  assert.match(await weather('北京'), /暂时不可用/)
  assert.equal(cancelled, true)
})
