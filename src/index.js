/**
 * dsh-bigmodel-consume 宿主端。
 *
 * 职责：
 *  1. 在宿主 Web 服务上注册同源 `/api/bigmodel-usage.*` RPC 路由（浏览器端
 *     通过 `connection.rpc.call('/api', 'bigmodel-usage.<endpoint>', payload)` 调用），
 *     由宿主转发对智谱 monitor 端点的请求——绕开浏览器 CORS 限制。
 *  2. 管理 API Key 与组织/项目上下文配置（存放在
 *     `<dsh home>/plugins/dsh-bigmodel-consume/config.json`）。
 *
 * Key 解析优先级：插件配置 > DSH 凭据库(ZAI_API_KEY) > 环境变量 ZAI_API_KEY。
 *
 * 用量端点同时兼容两代协议（按配置与响应自动适配）：
 *  - 旧版 CodingPlan：GET https://open.bigmodel.cn/api/monitor/usage/quota/limit
 *    （Bearer 认证，无需组织头；行类型 TOKENS_LIMIT / CREDIT_LIMIT）
 *  - 新版积分套餐（2026-07 改版后，含团队套餐）：
 *    GET https://bigmodel.cn/api/monitor/usage/quota/limit?type=<1|2>
 *    （raw key 认证 + bigmodel-organization / bigmodel-project 头；行类型 CREDIT_LIMIT）
 *
 * 本文件只依赖 Node 内置模块与宿主运行时注入的服务，无任何 npm 依赖。
 */
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 供 Loader 显示的插件名。 */
export const name = 'dsh-bigmodel-consume'
/** 宿主端无前置服务依赖；connection 在 apply 内按需注入（headless 组合没有它）。 */
export const inject = []

/** /api 通道下的方法名前缀，浏览器端与这里必须一致。 */
const PREFIX = 'bigmodel-usage.'
/** 全部端点；每个端点一条 exact POST 路由。 */
const ENDPOINTS = ['config', 'setConfig', 'usage']

/** 区域 → 端点 host。cn 覆盖新旧两代协议，intl 是 z.ai 国际站。 */
const HOSTS = {
  cn: { legacy: 'https://open.bigmodel.cn', modern: 'https://bigmodel.cn' },
  intl: { legacy: 'https://api.z.ai', modern: 'https://api.z.ai' },
}
/** 单次上游请求超时。 */
const REQUEST_TIMEOUT_MS = 20000
/** usage 结果缓存时长（force 可绕过）。 */
const CACHE_TTL_MS = 60000
/** 配置文件里允许的字段及默认值。 */
const DEFAULT_CONFIG = {
  apiKey: '',
  organization: '',
  project: '',
  planType: 2,
  region: 'cn',
  pollMinutes: 5,
}

/* ------------------------------------------------------------------ *
 * DSH home 与配置读写
 * ------------------------------------------------------------------ */

let dshHomeCache
/** DSH home 目录；优先用官方 @deepseek-ai/dsh-home-paths（宿主运行时可解析）。 */
async function dshHome() {
  if (dshHomeCache !== undefined) return dshHomeCache
  let home
  try {
    const mod = await import('@deepseek-ai/dsh-home-paths')
    home = typeof mod.dshHomePath === 'function' ? mod.dshHomePath() : undefined
  } catch {
    home = undefined
  }
  if (typeof home !== 'string' || home.length === 0) {
    home = process.env.DSH_HOME || join(homedir(), '.dsh')
  }
  dshHomeCache = home
  return home
}

async function configPath() {
  return join(await dshHome(), 'plugins', 'dsh-bigmodel-consume', 'config.json')
}

/** 读取配置；文件缺失/损坏时返回默认值。 */
async function readConfig() {
  try {
    const raw = JSON.parse(await readFile(await configPath(), 'utf8'))
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_CONFIG }
    const cfg = { ...DEFAULT_CONFIG }
    if (typeof raw.apiKey === 'string') cfg.apiKey = raw.apiKey.trim()
    if (typeof raw.organization === 'string') cfg.organization = raw.organization.trim()
    if (typeof raw.project === 'string') cfg.project = raw.project.trim()
    if (raw.planType === 1 || raw.planType === 2) cfg.planType = raw.planType
    if (raw.region === 'cn' || raw.region === 'intl') cfg.region = raw.region
    if (Number.isFinite(raw.pollMinutes) && raw.pollMinutes >= 1 && raw.pollMinutes <= 1440) {
      cfg.pollMinutes = Math.round(raw.pollMinutes)
    }
    return cfg
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

/** 原子写入配置（tmp + rename，避免半截文件）。 */
async function writeConfig(cfg) {
  const path = await configPath()
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}

/** 从 DSH 凭据库读取 ZAI_API_KEY（refs 段，缩进两格的 `  NAME: value` 行）。 */
async function readCredentialsRef(refName) {
  try {
    const text = await readFile(join(await dshHome(), '.credentials.yaml'), 'utf8')
    const line = text.split(/\r?\n/).find(l => l.startsWith(`  ${refName}:`))
    const value = line ? line.slice(line.indexOf(':') + 1).trim() : ''
    return value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}

/** 解析生效的 key 及其来源。 */
async function resolveKey(cfg) {
  if (cfg.apiKey) return { key: cfg.apiKey, source: 'config' }
  const cred = await readCredentialsRef('ZAI_API_KEY')
  if (cred) return { key: cred, source: 'credentials' }
  const env = process.env.ZAI_API_KEY?.trim()
  if (env) return { key: env, source: 'env' }
  return { key: undefined, source: undefined }
}

/** 脱敏预览：前 6 后 4。 */
function keyPreview(key) {
  if (!key) return undefined
  if (key.length <= 12) return `${key.slice(0, 3)}…`
  return `${key.slice(0, 6)}…${key.slice(-4)}`
}

/* ------------------------------------------------------------------ *
 * 智谱用量 API
 * ------------------------------------------------------------------ */

function toFiniteNumber(value) {
  const n = typeof value === 'number' ? value
    : typeof value === 'string' && value.trim() !== '' ? Number(value)
      : NaN
  return Number.isFinite(n) ? n : undefined
}

function clampPercent(value) {
  const n = toFiniteNumber(value)
  if (n === undefined) return undefined
  return Math.max(0, Math.min(100, n))
}

/** 把一行 limit 归一化为窗口视图；解析不出百分比时返回 undefined。 */
function windowFromRow(row) {
  let consumed = clampPercent(row.percentage)
  if (consumed === undefined) {
    const used = toFiniteNumber(row.currentValue)
    const total = toFiniteNumber(row.usage)
    if (used !== undefined && total !== undefined && total > 0) {
      consumed = clampPercent((used / total) * 100)
    }
  }
  if (consumed === undefined) return undefined
  const used = toFiniteNumber(row.currentValue)
  const total = toFiniteNumber(row.usage)
  let remaining = toFiniteNumber(row.remaining)
  if (remaining === undefined && used !== undefined && total !== undefined) remaining = total - used
  const resetAt = toFiniteNumber(row.nextResetTime)
  return {
    /** 已用百分比（0-100，一位小数）。 */
    usedPercent: Math.round(consumed * 10) / 10,
    /** 剩余百分比。 */
    remainingPercent: Math.round((100 - consumed) * 10) / 10,
    /** 已用积分/额度（可能缺失）。 */
    used,
    /** 总积分/额度（可能缺失）。 */
    total,
    /** 剩余积分/额度（可能缺失）。 */
    remaining,
    /** 窗口重置时间（unix 毫秒，可能缺失）。 */
    resetAt,
  }
}

/**
 * 归一化响应体。limits 数组是新版形状；旧版字段名（fiveHourPercent 等）
 * 作为兜底。返回 undefined 表示响应里没有任何可用窗口。
 */
function parseQuotaBody(body) {
  if (body === null || typeof body !== 'object') return undefined
  if (body.success === false) return undefined
  const data = body.data !== null && typeof body.data === 'object' ? body.data : body
  const out = { fiveHour: undefined, weekly: undefined, monthlyMcp: undefined }
  if (Array.isArray(data.limits)) {
    for (const row of data.limits) {
      if (row === null || typeof row !== 'object') continue
      const isCredit = row.type === 'CREDIT_LIMIT' || row.type === 'TOKENS_LIMIT'
      if (isCredit) {
        const unit = toFiniteNumber(row.unit)
        if (unit === 3) out.fiveHour = windowFromRow(row) ?? out.fiveHour
        else if (unit === 6) out.weekly = windowFromRow(row) ?? out.weekly
      } else if (row.type === 'TIME_LIMIT') {
        out.monthlyMcp = windowFromRow(row) ?? out.monthlyMcp
      }
    }
  }
  // 旧版字段名兜底（嵌套 quota 也接受）
  const nested = data.quota !== null && typeof data.quota === 'object' ? data.quota : data
  const legacyAt = (key) => clampPercent(nested[key] ?? nested[`${key}Percent`])
  if (out.fiveHour === undefined) {
    const p = legacyAt('fiveHourUsage') ?? legacyAt('fiveHourUsed') ?? clampPercent(nested.fiveHourPercent)
    if (p !== undefined) out.fiveHour = { usedPercent: p, remainingPercent: 100 - p }
  }
  if (out.weekly === undefined) {
    const p = legacyAt('weeklyUsage') ?? legacyAt('weeklyUsed') ?? clampPercent(nested.weeklyPercent)
    if (p !== undefined) out.weekly = { usedPercent: p, remainingPercent: 100 - p }
  }
  if (out.monthlyMcp === undefined) {
    const p = clampPercent(nested.monthlyMCPUsage) ?? clampPercent(nested.monthlyPercent)
    if (p !== undefined) out.monthlyMcp = { usedPercent: p, remainingPercent: 100 - p }
  }
  if (out.fiveHour === undefined && out.weekly === undefined && out.monthlyMcp === undefined) return undefined
  const level = typeof data.level === 'string' && data.level.length > 0 ? data.level : undefined
  return { ...out, level }
}

/** 分类上游错误。authFailure=true 表示明确的认证/授权失败。 */
function upstreamError(status, body) {
  const msg = body !== null && typeof body === 'object' && typeof body.msg === 'string'
    ? body.msg
    : `HTTP ${status}`
  if ((status === 401 || status === 403)
    || (body !== null && typeof body === 'object' && (body.code === 1000 || body.code === 1001))) {
    return { code: 'invalid-key', message: msg, authFailure: true }
  }
  if (status === 429 || status === 408) return { code: 'upstream', message: msg, authFailure: false }
  if (status >= 500) return { code: 'upstream', message: msg, authFailure: false }
  if (body !== null && typeof body === 'object' && body.success === false) {
    return { code: 'api', message: msg, authFailure: /auth|token|key|权限|认证/i.test(msg) }
  }
  return { code: 'api', message: msg, authFailure: false }
}

/** 执行一次请求尝试。 */
async function attempt({ url, headers, signal }) {
  let response
  try {
    response = await fetch(url, {
      headers: { accept: 'application/json', ...headers },
      redirect: 'error',
      signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    const cause = error !== null && typeof error === 'object' && 'cause' in error ? error.cause : undefined
    const detail = cause !== null && typeof cause === 'object' && typeof cause.message === 'string'
      ? cause.message
      : String(error)
    return { ok: false, error: { code: 'network', message: detail, authFailure: false } }
  }
  let body
  try {
    body = await response.json()
  } catch {
    body = undefined
  }
  if (!response.ok) return { ok: false, error: upstreamError(response.status, body) }
  const parsed = parseQuotaBody(body)
  if (parsed === undefined) {
    return { ok: false, error: upstreamError(response.status, body) }
  }
  return { ok: true, value: { ...parsed, fetchedAt: Date.now() } }
}

/**
 * 请求智谱用量。按配置构造尝试序列（新版组织上下文优先，随后旧版 Bearer），
 * 依次尝试直到成功；认证失败会翻转 Authorization 形式再试一次。
 */
async function fetchQuotaSnapshot(cfg, key, signal) {
  const hosts = HOSTS[cfg.region] ?? HOSTS.cn
  const attempts = []
  if (cfg.organization && cfg.project) {
    const base = `${hosts.modern}/api/monitor/usage/quota/limit?type=${cfg.planType === 1 ? 1 : 2}`
    attempts.push({
      label: 'modern-raw',
      url: base,
      headers: {
        authorization: key,
        'bigmodel-organization': cfg.organization,
        'bigmodel-project': cfg.project,
      },
    })
    attempts.push({
      label: 'modern-bearer',
      url: base,
      headers: {
        Authorization: `Bearer ${key}`,
        'bigmodel-organization': cfg.organization,
        'bigmodel-project': cfg.project,
      },
    })
  }
  attempts.push({ label: 'legacy-bearer', url: `${hosts.legacy}/api/monitor/usage/quota/limit`, headers: { Authorization: `Bearer ${key}` } })
  attempts.push({ label: 'legacy-raw', url: `${hosts.legacy}/api/monitor/usage/quota/limit`, headers: { authorization: key } })

  let lastError
  for (const item of attempts) {
    let result = await attempt({ url: item.url, headers: item.headers, signal })
    if (!result.ok && result.error.authFailure && !item.label.endsWith('-raw') && !item.label.endsWith('-bearer-flip')) {
      // 翻转认证形式重试一次（raw ↔ Bearer）
      const flipped = item.headers.Authorization
        ? { authorization: key, ...dropKeys(item.headers, ['Authorization']) }
        : { Authorization: `Bearer ${key}`, ...dropKeys(item.headers, ['authorization']) }
      result = await attempt({ url: item.url, headers: flipped, signal })
    }
    if (result.ok) return result
    lastError = result.error
    if (result.error.authFailure && item.label.startsWith('legacy') && attempts.length <= 2) break
  }
  return { ok: false, error: lastError ?? { code: 'unknown', message: 'no attempt made' } }
}

function dropKeys(object, keys) {
  const out = { ...object }
  for (const key of keys) delete out[key]
  return out
}

/* ------------------------------------------------------------------ *
 * usage 缓存与端点分发
 * ------------------------------------------------------------------ */

let usageCache = { sig: '', at: 0, value: undefined }

function cacheSignature(cfg, key) {
  return [cfg.region, cfg.organization, cfg.project, cfg.planType, key ? `${key.length}:${key.slice(-6)}` : '']
    .join('|')
}

async function getConfigView() {
  const cfg = await readConfig()
  const { key, source } = await resolveKey(cfg)
  return {
    hasKey: key !== undefined,
    keySource: source ?? null,
    keyPreview: keyPreview(key) ?? null,
    organization: cfg.organization,
    project: cfg.project,
    planType: cfg.planType,
    region: cfg.region,
    pollMinutes: cfg.pollMinutes,
  }
}

async function handleUsage(payload, signal) {
  const cfg = await readConfig()
  const { key, source } = await resolveKey(cfg)
  if (key === undefined) {
    return {
      ok: false,
      error: { code: 'no-key', message: '未配置 API Key；请在插件设置中填入智谱 API Key' },
    }
  }
  const force = payload !== null && typeof payload === 'object' && payload.force === true
  const sig = cacheSignature(cfg, key)
  if (!force && usageCache.sig === sig && usageCache.at > Date.now() - CACHE_TTL_MS) {
    return { ok: true, value: { ...usageCache.value, cached: true, keySource: source } }
  }
  const result = await fetchQuotaSnapshot(cfg, key, signal)
  if (!result.ok) return { ok: false, error: result.error }
  usageCache = { sig, at: Date.now(), value: result.value }
  return { ok: true, value: { ...result.value, cached: false, keySource: source } }
}

async function handleSetConfig(payload) {
  if (payload === null || typeof payload !== 'object') {
    return { ok: false, error: { code: 'bad-request', message: 'payload must be an object' } }
  }
  const cfg = await readConfig()
  const next = { ...cfg }
  const stringField = (field, max) => {
    if (typeof payload[field] !== 'string') return
    const value = payload[field].trim().slice(0, max)
    next[field] = value
  }
  stringField('apiKey', 4096)
  stringField('organization', 256)
  stringField('project', 256)
  if (payload.region === 'cn' || payload.region === 'intl') next.region = payload.region
  if (payload.planType === 1 || payload.planType === 2) next.planType = payload.planType
  if (Number.isFinite(payload.pollMinutes)) {
    next.pollMinutes = Math.max(1, Math.min(1440, Math.round(payload.pollMinutes)))
  }

  // key 变化时先做一次真实校验：明确的认证失败不落盘
  let tested = 'skipped'
  let testUsage
  if (next.apiKey !== '' && next.apiKey !== cfg.apiKey) {
    const probe = await fetchQuotaSnapshot(next, next.apiKey)
    if (!probe.ok && probe.error.authFailure) {
      return { ok: false, error: probe.error }
    }
    tested = probe.ok ? 'ok' : 'network'
    if (probe.ok) {
      const sig = cacheSignature(next, next.apiKey)
      usageCache = { sig, at: Date.now(), value: probe.value }
      testUsage = probe.value
    }
  }
  await writeConfig(next)
  return { ok: true, value: { saved: true, tested, usage: testUsage } }
}

/** 端点分发；返回 {ok,value} 或 {ok:false,error:{code,message}}。 */
async function dispatch(endpoint, payload, signal) {
  try {
    switch (endpoint) {
      case 'config': return { ok: true, value: await getConfigView() }
      case 'setConfig': return await handleSetConfig(payload)
      case 'usage': return await handleUsage(payload, signal)
      default: return { ok: false, error: { code: 'bad-request', message: `unknown endpoint "${endpoint}"` } }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: { code: 'internal', message } }
  }
}

/* ------------------------------------------------------------------ *
 * /api 通道路由（信封协议与 dsh 客户端 RPC 调用者一致）
 * ------------------------------------------------------------------ */

function readEnvelope(body) {
  if (body === null || typeof body !== 'object') return undefined
  if (body.type !== 'client-request' || typeof body.rpcId !== 'string' || typeof body.method !== 'string') return undefined
  return { rpcId: body.rpcId, method: body.method, payload: body.payload }
}

function serverResponse(rpcId, result) {
  return Response.json({ type: 'server-response', rpcId, result })
}

const BAD_REQUEST_RESULT = {
  ok: false,
  error: { code: 'gateway/bad-request', message: 'invalid client-request message', details: { issues: [] } },
}

function fetchRouteFor(endpoint) {
  const method = `${PREFIX}${endpoint}`
  return {
    path: `/api/${method}`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (contentType !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 })
      }
      let body
      try {
        body = await request.json()
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }
      const envelope = readEnvelope(body)
      if (envelope === undefined) {
        // 兼容通道：非信封的裸 JSON 对象直接视为 payload。
        // 若未来 DSH 客户端 RPC 信封变化，浏览器端可退回普通同源 fetch
        // 打到同一路由，宿主端无需改动即可继续工作。
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          return serverResponse(typeof body?.rpcId === 'string' ? body.rpcId : 'invalid-request', BAD_REQUEST_RESULT)
        }
        return serverResponse('bare', await dispatch(endpoint, body, request.signal))
      }
      if (envelope.method !== method) {
        return serverResponse(envelope.rpcId, {
          ok: false,
          error: {
            code: 'gateway/bad-request',
            message: `method ${JSON.stringify(envelope.method)} does not match endpoint ${JSON.stringify(method)}`,
            details: { issues: [] },
          },
        })
      }
      return serverResponse(envelope.rpcId, await dispatch(endpoint, envelope.payload, request.signal))
    },
  }
}

/* ------------------------------------------------------------------ *
 * 插件入口
 * ------------------------------------------------------------------ */

/**
 * 激活宿主端：有 connection（Web/桌面组合）时注册 /api 路由。
 * @param ctx - 插件上下文。
 * @returns 完成时 resolve。
 */
export async function apply(ctx) {
  ctx.inject(['connection'], (ctx2) => {
    const connection = ctx2.get('connection')
    const register = connection !== null && typeof connection === 'object'
      && connection.fetch !== null && typeof connection.fetch === 'object'
      ? connection.fetch.register
      : undefined
    if (typeof register !== 'function') {
      console.error('[dsh-bigmodel-consume] connection.fetch.register 不可用——宿主接口可能已变化，宿主端路由未注册')
      return
    }
    for (const endpoint of ENDPOINTS) {
      ctx2.effect(
        () => register(fetchRouteFor(endpoint)),
        `dsh-bigmodel-consume: /api/${PREFIX}${endpoint} route`,
      )
    }
  })
}
