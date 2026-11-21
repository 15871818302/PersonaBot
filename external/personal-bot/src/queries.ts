import { createHash } from 'node:crypto'
import { PublicError } from './public-error'

const defaultEndpoints = {
  WEATHER_GEOCODING_URL: 'https://geocoding-api.open-meteo.com/v1/search',
  WEATHER_FORECAST_URL: 'https://api.open-meteo.com/v1/forecast',
  KUAIDI100_QUERY_URL: 'https://poll.kuaidi100.com/poll/query.do',
}

export function queryEndpoint(name: keyof typeof defaultEndpoints) {
  const url = new URL(process.env[name]?.trim() || defaultEndpoints[name])
  if (url.protocol !== 'https:') throw new Error('query endpoint requires HTTPS')
  return url
}

const maxResponseBytes = 256 * 1024

async function requestJson(url: URL | string, options: RequestInit = {}) {
  const timeout = AbortSignal.timeout(8000)
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout
  const response = await fetch(url, { ...options, redirect: 'error', signal })
  if (!response.ok || !response.body) {
    await response.body?.cancel()
    throw new Error('provider unavailable')
  }

  const chunks: Uint8Array[] = []
  let length = 0
  const reader = response.body.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.length
    if (length > maxResponseBytes) {
      await reader.cancel()
      throw new Error('provider response too large')
    }
    chunks.push(value)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export async function searchMeme(query: string, key: string, deadline: AbortSignal): Promise<{ content: string, url: string }[]> {
  try {
    const data = await requestJson('https://api.tavily.com/search', {
      method: 'POST', signal: deadline,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, search_depth: 'basic', max_results: 3 }),
    })
    if (!Array.isArray(data?.results)) return []
    return data.results.slice(0, 3).flatMap((item: { content?: string, url?: string }) => {
      if (typeof item?.content !== 'string' || !item.content.trim()) return []
      const url = typeof item.url === 'string' && item.url.length <= 512 && /^https?:\/\//i.test(item.url) ? item.url : ''
      return [{ content: item.content.trim().slice(0, 500), url }]
    })
  } catch {
    if (deadline.aborted) throw new PublicError('这次聊天超时了，请稍后重试。')
    return []
  }
}

const weatherCodes: Record<number, string> = {
  0: '晴', 1: '大部晴朗', 2: '多云', 3: '阴', 45: '雾', 48: '雾凇',
  51: '小毛毛雨', 53: '毛毛雨', 55: '较强毛毛雨', 56: '轻微冻毛毛雨', 57: '较强冻毛毛雨',
  61: '小雨', 63: '中雨', 65: '大雨', 66: '小冻雨', 67: '大冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '米雪',
  80: '小阵雨', 81: '中阵雨', 82: '强阵雨', 85: '小阵雪', 86: '强阵雪',
  95: '雷暴', 96: '雷暴伴小冰雹', 99: '雷暴伴大冰雹',
}

const placeName = /^[\p{Script=Han}a-zA-Z· -]{1,48}$/u
const weatherFailure = '天气服务暂时不可用，请稍后重试。'

function inRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && value >= min && value <= max
}

export async function weather(city: string): Promise<string> {
  if (typeof city !== 'string' || city.length > 48 || !/^[\p{Script=Han}a-zA-Z][\p{Script=Han}a-zA-Z· -]{1,39}$/u.test(city.trim())) {
    return '请输入城市名称，例如「天气 杭州」。'
  }
  const name = city.trim().replace(/^(.{2,})市$/u, '$1')
  try {
    const search = queryEndpoint('WEATHER_GEOCODING_URL')
    for (const [key, value] of Object.entries({ name, count: '1', language: 'zh', countryCode: 'CN' })) {
      search.searchParams.set(key, value)
    }
    const places = await requestJson(search)
    const place = places.results?.[0]
    if (!place) return '未找到这个城市，请尝试城市简称或拼音。'
    if (place.country_code !== 'CN' || typeof place.name !== 'string' || !placeName.test(place.name)
      || !inRange(place.latitude, -90, 90) || !inRange(place.longitude, -180, 180)) return weatherFailure

    const forecast = queryEndpoint('WEATHER_FORECAST_URL')
    for (const [key, value] of Object.entries({
      latitude: String(place.latitude), longitude: String(place.longitude), timezone: 'Asia/Shanghai',
      current: 'temperature_2m,relative_humidity_2m,weather_code',
    })) forecast.searchParams.set(key, value)
    const { current } = await requestJson(forecast)
    if (!current || !inRange(current.temperature_2m, -100, 80) || !inRange(current.relative_humidity_2m, 0, 100)
      || !Number.isInteger(current.weather_code) || typeof current.time !== 'string'
      || !/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(current.time)) return weatherFailure
    const region = typeof place.admin1 === 'string' && placeName.test(place.admin1) && place.admin1 !== place.name
      ? `（${place.admin1}）` : ''
    const condition = weatherCodes[current.weather_code] || '天气现象未知'
    return `我帮你看过啦！${place.name}${region}现在${condition}，气温 ${current.temperature_2m}°C，相对湿度 ${current.relative_humidity_2m}%。\n北京时间 ${current.time.replace('T', ' ')} · Open-Meteo / GeoNames`
  } catch {
    return weatherFailure
  }
}

const carriers = new Map(Object.entries({
  '圆通': 'yuantong', '圆通速递': 'yuantong', '申通': 'shentong', '申通快递': 'shentong',
  '韵达': 'yunda', '韵达快递': 'yunda', '京东': 'jd', '京东物流': 'jd',
  '德邦': 'debangkuaidi', '德邦快递': 'debangkuaidi', '德邦物流': 'debangwuliu',
  '邮政快递包裹': 'youzhengguonei', '极兔': 'jtexpress', '极兔速递': 'jtexpress',
  '顺丰': 'shunfeng', '顺丰速运': 'shunfeng', '顺丰快运': 'shunfengkuaiyun',
  '中通': 'zhongtong', '中通快递': 'zhongtong',
}))
const needsPhone = new Set(['shunfeng', 'shunfengkuaiyun', 'zhongtong'])
const shipmentStates: Record<number, string> = {
  0: '在途', 1: '揽收', 2: '运输异常', 3: '签收', 4: '退签', 5: '派件中', 6: '退回',
  7: '转投', 8: '清关', 10: '待清关', 11: '清关中', 12: '已清关', 13: '清关异常', 14: '拒签',
}
const recentShipments = new Map<string, { expires: number, result: Promise<string> }>()
const trackingFailure = '快递查询暂时不可用，请核对快递公司和单号，半小时后重试。'

async function queryShipment(com: string, num: string, customer: string, key: string): Promise<string> {
  try {
    const param = JSON.stringify({ com, num, show: '0', order: 'desc', lang: 'zh' })
    const sign = createHash('md5').update(param + key + customer).digest('hex').toUpperCase()
    const data = await requestJson(queryEndpoint('KUAIDI100_QUERY_URL'), {
      method: 'POST', body: new URLSearchParams({ customer, sign, param }),
    })
    if (String(data.status) !== '200' || data.com !== com || typeof data.nu !== 'string'
      || data.nu.toUpperCase() !== num || !Array.isArray(data.data)) return trackingFailure
    if (!data.data.length) return '我看了一眼，尾号 ' + num.slice(-4) + ' 的包裹还没有物流记录。过会儿再来找我看看吧。'
    if (typeof data.state !== 'string' && typeof data.state !== 'number') return trackingFailure
    const status = Object.hasOwn(shipmentStates, data.state) ? shipmentStates[data.state] : '状态待更新'
    const time = data.data[0]?.ftime
    const suffix = typeof time === 'string' && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(time) ? `\n最新记录 ${time}` : ''
    return `我帮你看了尾号 ${num.slice(-4)} 的包裹，物流上写的是「${status}」。${suffix}`
  } catch {
    return trackingFailure
  }
}

export async function track(carrier: string, number: string): Promise<string> {
  if (typeof carrier !== 'string' || carrier.length > 40) return '请输入快递公司名称或快递100公司编码。'
  const carrierName = carrier.trim().toLowerCase()
  const com = carriers.get(carrierName) ?? carrierName
  if (!/^[a-z][a-z0-9]{1,31}$/.test(com)) return '请输入快递公司名称或快递100公司编码，例如「快递 韵达 单号」。'
  if (typeof number !== 'string' || number.length > 40 || !/^[a-zA-Z0-9]{6,32}$/.test(number.trim())) return '单号应为 6 至 32 位字母或数字。'
  if (needsPhone.has(com)) return '该公司要求验证收寄件人的手机号，请通过快递公司的官方渠道查询。'

  const customer = process.env.KUAIDI100_CUSTOMER?.trim()
  const key = process.env.KUAIDI100_KEY?.trim()
  if (!customer || !key) return '尚未配置快递100服务凭据。'
  const num = number.trim().toUpperCase()
  const cacheKey = createHash('sha256').update(`${com}:${num}`).digest('hex')
  const now = Date.now()
  for (const [id, entry] of recentShipments) {
    if (entry.expires <= now) recentShipments.delete(id)
  }
  const existing = recentShipments.get(cacheKey)
  if (existing) return existing.result
  if (recentShipments.size >= 256) return '近期查询单号过多，请稍后再试。'
  const result = queryShipment(com, num, customer, key)
  recentShipments.set(cacheKey, { expires: now + 30 * 60 * 1000, result })
  return result
}
