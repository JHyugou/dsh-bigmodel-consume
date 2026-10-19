/**
 * 冒烟测试（本地运行，不依赖 DSH 运行时）：
 *   node smoke.mjs
 *
 * 1. 宿主端：注入假 ctx/connection，注册 /api 路由，依次调用
 *    config / usage 端点——usage 会用真实 key 发起一次真实 HTTP 请求，
 *    验证凭据解析、上游协议适配与响应归一化。
 * 2. 浏览器端：在 vm 沙箱里加载 client bundle，校验模块注册、
 *    factory 导出形状与 apply(ctx) 的插槽注册流程。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const root = dirname(fileURLToPath(import.meta.url))
let failures = 0
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? ` :: ${detail}` : ''}`)
  if (!ok) failures += 1
}

/* ---------------- 1. 宿主端 ---------------- */

const routes = new Map()
const innerCtx = {
  get(name) {
    if (name !== 'connection') throw new Error(`unexpected service ${name}`)
    return {
      fetch: {
        register: (route) => {
          if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
          routes.set(route.path, route)
          return () => routes.delete(route.path)
        },
      },
    }
  },
  effect(fn, label) {
    const dispose = fn()
    if (typeof dispose !== 'function') throw new Error(`effect ${label} returned non-disposer`)
    return dispose
  },
}
const hostCtx = {
  inject(deps, callback) {
    check('host inject declares connection', JSON.stringify(deps) === '["connection"]')
    callback(innerCtx)
  },
}

const host = await import(pathToFileURL(join(root, 'src/index.js')).href)
await host.apply(hostCtx)

check('three /api routes registered', routes.size === 3, [...routes.keys()].join(', '))

function makeRequest(endpoint, payload) {
  return {
    headers: new Map([['content-type', 'application/json']]),
    json: async () => ({ type: 'client-request', rpcId: 'r1', method: `bigmodel-usage.${endpoint}`, payload }),
    signal: undefined,
  }
}

async function callEndpoint(endpoint, payload) {
  const route = routes.get(`/api/bigmodel-usage.${endpoint}`)
  if (route === undefined) throw new Error(`route missing for ${endpoint}`)
  const response = await route.fetch(makeRequest(endpoint, payload))
  const body = await response.json()
  if (body.type !== 'server-response' || body.rpcId !== 'r1') throw new Error('bad envelope')
  return body.result
}

const configResult = await callEndpoint('config', {})
check('config endpoint ok', configResult.ok === true, JSON.stringify(configResult.value))

if (configResult.value?.hasKey) {
  const usageResult = await callEndpoint('usage', { force: true })
  if (usageResult.ok) {
    const usage = usageResult.value
    check('usage endpoint ok', true,
      `5h=${usage.fiveHour ? `${usage.fiveHour.usedPercent}%` : 'n/a'} `
      + `week=${usage.weekly ? `${usage.weekly.usedPercent}%` : 'n/a'} `
      + `level=${usage.level ?? 'n/a'} source=${usage.keySource}`)
    check('fiveHour or weekly window present', usage.fiveHour !== undefined || usage.weekly !== undefined)
  } else {
    check('usage endpoint ok', false, JSON.stringify(usageResult.error))
  }
} else {
  console.log('SKIP  live usage fetch (no key resolved; set ZAI_API_KEY to test live)')
}

// 错误信封：方法名不匹配
{
  const route = routes.get('/api/bigmodel-usage.usage')
  const response = await route.fetch({
    headers: new Map([['content-type', 'application/json']]),
    json: async () => ({ type: 'client-request', rpcId: 'r9', method: 'bigmodel-usage.other', payload: {} }),
    signal: undefined,
  })
  const body = await response.json()
  check('method mismatch rejected', body.result?.ok === false && body.rpcId === 'r9')
}

// 兼容通道：裸 JSON（无信封）直接作为 payload——客户端 fetch 兜底路径
{
  const route = routes.get('/api/bigmodel-usage.config')
  const response = await route.fetch({
    headers: new Map([['content-type', 'application/json']]),
    json: async () => ({}),
    signal: undefined,
  })
  const body = await response.json()
  check('bare JSON payload accepted (envelope-free fallback)', body.type === 'server-response' && body.result?.ok === true, `rpcId=${body.rpcId}`)
}

// setConfig 校验路径（写入临时 DSH_HOME，不碰真实配置）
{
  const realHome = process.env.DSH_HOME
  process.env.DSH_HOME = join(root, '.smoke-home')
  const { rm } = await import('node:fs/promises')
  await rm(process.env.DSH_HOME, { recursive: true, force: true })
  // 重新加载模块以清掉 home 缓存
  const fresh = await import(`${pathToFileURL(join(root, 'src/index.js')).href}?fresh=${Date.now()}`)
  const routes2 = new Map()
  const ctx2 = {
    inject(deps, cb) {
      cb({
        get: () => ({ fetch: { register: (r) => { routes2.set(r.path, r); return () => {} } } }),
        effect(fn) { fn(); },
      })
    },
  }
  await fresh.apply(ctx2)
  const route = routes2.get('/api/bigmodel-usage.setConfig')
  const bad = await (await route.fetch({
    headers: new Map([['content-type', 'application/json']]),
    json: async () => ({ type: 'client-request', rpcId: 'r2', method: 'bigmodel-usage.setConfig', payload: 'not-an-object' }),
    signal: undefined,
  })).json()
  check('setConfig rejects non-object payload', bad.result?.ok === false)
  process.env.DSH_HOME = realHome
}

/* ---------------- 2. 浏览器端 ---------------- */

{
  const loads = []
  const sandbox = {
    window: { __ModuleLoader__: { load: (registration) => loads.push(registration) } },
    document: {
      visibilityState: 'visible',
      createElement: () => ({ setAttribute() {}, style: {}, textContent: '' }),
      head: { appendChild() {} },
      addEventListener() {},
      removeEventListener() {},
    },
    setInterval: () => 0,
    clearInterval() {},
  }
  vm.createContext(sandbox)
  vm.runInContext(readFileSync(join(root, 'src/client.js'), 'utf8'), sandbox, { filename: 'client.js' })
  check('bundle registered once', loads.length === 1)
  check('bundle id is package name', loads[0]?.id === 'dsh-bigmodel-consume')

  const fakeReact = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: null }),
    useCallback: (fn) => fn,
    useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  }
  const clientExports = loads[0].factory((id) => {
    if (id === 'react') return fakeReact
    throw new Error(`unexpected require: ${id}`)
  })
  check('client exports apply function', typeof clientExports.apply === 'function')
  check('client inject lists slots+locale', JSON.stringify(clientExports.inject) === '["slots","locale"]')

  const registrations = []
  const modelDirectories = {
    directoryFor: () => ({
      store: {
        subscribe: () => () => {},
        getSnapshot: () => ({ current: { provider: 'zai', model: 'glm-5.3' } }),
      },
    }),
  }
  const slotsFace = {
    inject: (slot, make) => { make() },
    register: (options, component) => {
      registrations.push({ slot: options.name, options, component })
      return () => {}
    },
  }
  const clientCtx = {
    effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : undefined },
    inject(deps, callback) {
      if (JSON.stringify(deps) !== '["modelDirectories"]') throw new Error(`unexpected runtime inject ${deps}`)
      callback({ slots: slotsFace, modelDirectories })
    },
    on() {},
    get(name) {
      if (name !== 'connection') throw new Error(`unexpected get(${name})`)
      return { rpc: { call: async () => ({ ok: true, value: {} }) } }
    },
    locale: { register: () => () => {}, bind: () => (key) => key },
    slots: slotsFace,
  }
  clientExports.apply(clientCtx)
  const slots = registrations.map(r => `${r.slot}#${r.options.id ?? ''}`)
  check('registers composer input pill', slots.includes('conversation.input.right#bigmodel-usage'), slots.join(', '))
  check('registers settings section', registrations.some(r => r.slot === 'settings.section' && typeof r.options.label === 'function'))
  check('components are functions', registrations.every(r => typeof r.component === 'function'))

  // 组件渲染冒烟：zai 模型 → 渲染药丸；deepseek 模型 → 不渲染
  const pill = registrations.find(r => r.slot === 'conversation.input.right')
  const storeStub = {
    subscribe: () => () => {},
    getSnapshot: () => ({ phase: 'ready', config: { hasKey: true, keySource: 'credentials' }, usage: { fiveHour: { usedPercent: 27, remainingPercent: 73 }, weekly: { usedPercent: 5, remainingPercent: 95 } } }),
    refreshIfStale() {},
  }
  const zaiElement = pill.component({ directory: modelDirectories.directoryFor('s').store, store: storeStub, t: (key) => key })
  check('pill renders for zai model', zaiElement !== null && typeof zaiElement === 'object')
  const deepseekDirectory = { subscribe: () => () => {}, getSnapshot: () => ({ current: { provider: 'deepseek', model: 'chat' } }) }
  const noneElement = pill.component({ directory: deepseekDirectory, store: storeStub, t: (key) => key })
  check('pill hidden for non-zhipu model', noneElement === null)

  // 兼容性：主插槽被移除（模拟未来 API 变化）→ 自动降级到 composer.dock
  {
    const fallbackRegistrations = []
    const pickySlots = {
      inject: (slot, make) => { make() },
      register: (options, component) => {
        if (options.name === 'conversation.input.right') throw new Error('undeclared slot (simulated removal)')
        fallbackRegistrations.push({ slot: options.name, id: options.id })
        return () => {}
      },
    }
    const ctxFallback = {
      effect(fn) { const d = fn(); return typeof d === 'function' ? d : undefined },
      inject(deps, cb) { cb({ slots: pickySlots, modelDirectories }) },
      on() {},
      get(name) { if (name !== 'connection') throw new Error(`unexpected get(${name})`); return { rpc: { call: async () => ({ ok: true, value: {} }) } } },
      locale: { register: () => () => {}, bind: () => (key) => key },
      slots: pickySlots,
    }
    let threw = false
    try { clientExports.apply(ctxFallback) } catch { threw = true }
    check('fail-soft: apply survives slot removal without throwing', !threw)
    check('slot fallback: pill degrades to composer.dock', fallbackRegistrations.some(r => r.slot === 'conversation.composer.dock' && r.id === 'bigmodel-usage'),
      fallbackRegistrations.map(r => r.slot).join(', '))
  }

  // 兼容性：connection 服务缺失 → 不炸，设置页仍注册
  {
    const surviving = []
    const plainSlots = { inject: (slot, make) => { make() }, register: (o) => { surviving.push(o.name); return () => {} } }
    const ctxNoConn = {
      effect(fn) { const d = fn(); return typeof d === 'function' ? d : undefined },
      inject(deps, cb) { cb({ slots: plainSlots, modelDirectories }) },
      on() {},
      get() { throw new Error('connection missing (simulated)') },
      locale: { register: () => () => {}, bind: () => (key) => key },
      slots: plainSlots,
    }
    let threw = false
    try { clientExports.apply(ctxNoConn) } catch { threw = true }
    check('fail-soft: missing connection service does not throw', !threw)
    check('fail-soft: settings section still registers', surviving.includes('settings.section'))
  }
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
