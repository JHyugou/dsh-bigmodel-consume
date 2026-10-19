/**
 * DSH 更新后兼容性体检：node doctor.mjs [端口=19387]
 *
 * 逐层检查插件依赖的全部接缝，输出 PASS/WARN/FAIL 报告与处置建议。
 * DSH 桌面端升级后跑一次，30 秒内知道插件是否仍然健康、坏在哪一层。
 */
import { createHash, createHmac } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const AUTHORITY = `127.0.0.1:${Number(process.argv[2]) || 19387}`
const PKG = 'dsh-bigmodel-consume'

let failures = 0
let warnings = 0
const pass = (label, detail) => { console.log(`PASS  ${label}${detail ? `  — ${detail}` : ''}`) }
const warn = (label, detail) => { warnings += 1; console.log(`WARN  ${label}${detail ? `  — ${detail}` : ''}`) }
const fail = (label, detail) => { failures += 1; console.log(`FAIL  ${label}${detail ? `  — ${detail}` : ''}`) }

console.log(`dsh-bigmodel-consume 兼容性体检 → http://${AUTHORITY}\n`)

/* ---- 第 0 层：本机凭据 ---- */
let cookie
try {
  const b64url = (buf) => Buffer.from(buf).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
  const unb64url = (v) => { const p = '='.repeat((4 - v.length % 4) % 4); return Buffer.from(v.replaceAll('-', '+').replaceAll('_', '/') + p, 'base64') }
  const cred = await readFile(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
  const secretLine = cred.split(/\r?\n/).find(l => l.includes('secret:'))
  const secret = unb64url(secretLine.split('secret:')[1].trim())
  const name = `dsh-auth-${b64url(createHash('sha256').update(AUTHORITY).digest())}`
  const issuedAt = Date.now()
  const body = b64url(Buffer.from(JSON.stringify({ version: 1, authority: AUTHORITY, issuedAt, expiresAt: issuedAt + 3600000 })))
  cookie = `${name}=v1.${body}.${b64url(createHmac('sha256', secret).update(body).digest())}`
  pass('L0 浏览器会话凭据可读（本机信任域）')
} catch (error) {
  fail('L0 浏览器会话凭据不可读', error.message)
  console.log('\n无法继续体检：请在本机以管理员用户运行。')
  process.exit(1)
}

const get = async (path) => fetch(`http://${AUTHORITY}${path}`, { headers: { cookie } })

/* ---- 第 1 层：DSH 宿主在线 + 插件已装载 ---- */
let html
try {
  const index = await get('/')
  if (index.status !== 200) throw new Error(`HTTP ${index.status}`)
  html = await index.text()
  pass('L1 DSH Web 宿主在线且认证通过')
} catch (error) {
  fail('L1 DSH Web 宿主不可达', `${error.message}（DSH 是否在运行？端口是否为 ${AUTHORITY}？）`)
  process.exit(1)
}

const row = html.match(new RegExp(`"id":"${PKG}","url":"([^"]+)","rev":"[^"]*","inject":\\[([^\\]]*)\\]`))
if (row) {
  pass('L2 插件已进入宿主启动图（bundle 清单 + Loader 装载正常）')
  if (row[2].includes('dsh-client-ui-model-selection')) {
    pass('L2 浏览器依赖声明含 ui-model-selection')
  } else {
    warn('L2 浏览器依赖声明缺 ui-model-selection（宿主包元数据缓存；重启 DSH 后刷新。不影响功能：运行时注入有等待语义）')
  }
} else {
  fail('L2 插件不在启动图中', 'profile 的 dsh.profile.bundles 缺失或包未安装——重新执行安装步骤')
}

/* ---- 第 3 层：浏览器 bundle 可服务且内容完整 ---- */
if (row) {
  const bundle = await get(`/${row[1]}`)
  const text = bundle.status === 200 ? await bundle.text() : ''
  if (bundle.status !== 200) {
    fail('L3 浏览器 bundle 无法下载', `HTTP ${bundle.status}`)
  } else {
    const markers = [
      ['ModuleLoader 注册头', 'window.__ModuleLoader__.load'],
      ['包名一致', PKG],
      ['药丸插槽注册', 'conversation.input.right'],
      ['降级插槽注册', 'conversation.composer.dock'],
      ['模型目录感知', 'modelDirectories'],
      ['设置页注册', 'settings.section'],
      ['RPC 兼容通道', 'plainCall'],
    ]
    const missing = markers.filter(([, needle]) => !text.includes(needle))
    if (missing.length === 0) pass(`L3 浏览器 bundle 完整（${text.length} 字节，${markers.length} 项标记齐全）`)
    else fail('L3 浏览器 bundle 标记缺失', missing.map(([label]) => label).join('、'))
  }
}

/* ---- 第 4 层：宿主端 RPC 路由（信封 + 裸 JSON 双协议） ---- */
async function rpcCall(payload, bare) {
  const response = await fetch(`http://${AUTHORITY}/api/bigmodel-usage.config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(bare ? payload : { type: 'client-request', rpcId: 'doctor', method: 'bigmodel-usage.config', payload }),
  })
  if (response.status !== 200) throw new Error(`HTTP ${response.status}`)
  const envelope = await response.json()
  return envelope.result
}
try {
  const result = await rpcCall({}, false)
  if (result?.ok === true) {
    pass('L4 宿主端 /api 路由在线（connection.fetch + 信封协议正常）', `keySource=${result.value?.keySource ?? 'none'}`)
    globalThis.__hasKey = result.value?.hasKey === true
  } else fail('L4 宿主端 /api 路由返回异常', JSON.stringify(result))
} catch (error) {
  fail('L4 宿主端 /api 路由不通', `${error.message}（connection.fetch.register 契约或信封协议可能已变化）`)
}
try {
  const result = await rpcCall({}, true)
  if (result?.ok === true) pass('L4 裸 JSON 兼容通道在线（信封变化时的兜底可用）')
  else warn('L4 裸 JSON 兼容通道未生效', '宿主端新代码需重启 DSH 进程后才加载（Node ESM 模块缓存）；信封主通道正常时功能不受影响')
} catch (error) {
  warn('L4 裸 JSON 兼容通道不通', error.message)
}

/* ---- 第 5 层：智谱上游 API ---- */
if (globalThis.__hasKey) {
  try {
    const response = await fetch(`http://${AUTHORITY}/api/bigmodel-usage.usage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ type: 'client-request', rpcId: 'doctor', method: 'bigmodel-usage.usage', payload: { force: true } }),
    })
    const { result } = await response.json()
    if (result?.ok === true) {
      const usage = result.value
      const fmt = (w) => w ? `${Math.round(w.usedPercent)}%` : 'n/a'
      pass('L5 智谱用量 API 正常', `5h 已用 ${fmt(usage.fiveHour)} · 周 ${fmt(usage.weekly)} · 档位 ${usage.level ?? 'n/a'}`)
    } else {
      fail('L5 智谱用量 API 返回错误', `${result?.error?.code ?? '?'}: ${result?.error?.message ?? ''}（Key 失效或智谱协议再改版）`)
    }
  } catch (error) {
    fail('L5 智谱用量 API 请求失败', error.message)
  }
} else {
  warn('L5 未配置 Key，跳过上游 API 检查')
}

/* ---- 汇总 ---- */
console.log('')
if (failures === 0 && warnings === 0) {
  console.log('结论：全部接缝健康，插件与当前 DSH 版本完全兼容。')
} else if (failures === 0) {
  console.log(`结论：功能正常，${warnings} 条提醒（见上）。`)
} else {
  console.log(`结论：${failures} 层损坏，${warnings} 条提醒。`)
  console.log('处置顺序：L2 失败→重装插件包；L3 失败→检查 bundle 标记对应的接口变化；')
  console.log('          L4 失败→connection.fetch 或信封协议变化（把本输出发给插件维护者即可定位）；')
  console.log('          L5 失败→智谱协议改版，需更新用量解析（与 DSH 版本无关）。')
}
process.exit(failures === 0 ? 0 : 1)
