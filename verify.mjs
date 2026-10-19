/**
 * 验证运行中的 DSH Web 宿主已加载本插件：
 *   node verify.mjs
 * 用本机凭据库里的 browser-session secret 铸造签名 cookie，
 * 拉取 http://127.0.0.1:19387/ 的 __DSH_BOOT__，确认 dsh-bigmodel-consume
 * 出现在启动图中，并尝试 GET 它的 client bundle。
 */
import { createHash, createHmac } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const AUTHORITY = '127.0.0.1:19387'

const b64url = (buf) => Buffer.from(buf).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
const unb64url = (value) => {
  const padding = '='.repeat((4 - value.length % 4) % 4)
  return Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/') + padding, 'base64')
}

const credentials = await readFile(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
const line = credentials.split(/\r?\n/).find(l => l.includes('secret:'))
const secretB64 = line ? line.split('secret:')[1].trim() : ''
const secret = unb64url(secretB64)
if (secret.length !== 32) {
  console.error('FAIL  无法解析 browser-session secret')
  process.exit(1)
}

const name = `dsh-auth-${b64url(createHash('sha256').update(AUTHORITY).digest())}`
const issuedAt = Date.now()
const body = b64url(Buffer.from(JSON.stringify({
  version: 1, authority: AUTHORITY, issuedAt, expiresAt: issuedAt + 30 * 86400000,
}), 'utf8'))
const value = `v1.${body}.${b64url(createHmac('sha256', secret).update(body).digest())}`

const index = await fetch(`http://${AUTHORITY}/`, { headers: { cookie: `${name}=${value}` } })
console.log('index status:', index.status)
if (index.status !== 200) process.exit(1)
const html = await index.text()

const marker = 'dsh-bigmodel-consume'
const at = html.indexOf(marker)
if (at === -1) {
  console.error('FAIL  启动图中没有 dsh-bigmodel-consume —— 插件尚未被宿主加载（可能需要重启 DSH 或等待 HMR）')
  process.exit(1)
}
console.log('PASS  插件出现在 __DSH_BOOT__ 启动图中')

// 找到它的 bundle URL 并尝试下载
const rowMatch = html.match(/plugins\/dsh-bigmodel-consume[^"'\\ &]*/u)
if (rowMatch) {
  const bundleUrl = `http://${AUTHORITY}/${rowMatch[0]}`
  const bundle = await fetch(bundleUrl, { headers: { cookie: `${name}=${value}` } })
  const text = bundle.status === 200 ? await bundle.text() : ''
  console.log(`bundle 下载 (${bundle.status}, ${text.length} bytes): ${bundleUrl}`)
  console.log(text.includes('window.__ModuleLoader__.load') && text.includes(marker)
    ? 'PASS  bundle 内容校验通过（ModuleLoader 注册 + 包名一致）'
    : 'WARN  bundle 内容与预期不完全一致')
} else {
  // 行可能打包进 combo URL；退而探测已知路由形状
  for (const candidate of ['client.js', 'client.index.js']) {
    const probe = await fetch(`http://${AUTHORITY}/plugins/dsh-bigmodel-consume/${candidate}`, { headers: { cookie: `${name}=${value}` } })
    console.log(`probe /plugins/dsh-bigmodel-consume/${candidate} → ${probe.status}`)
    if (probe.status === 200) {
      const text = await probe.text()
      console.log(text.includes('window.__ModuleLoader__.load') && text.includes(marker)
        ? 'PASS  bundle 内容校验通过（ModuleLoader 注册 + 包名一致）'
        : 'WARN  bundle 内容与预期不完全一致')
      break
    }
  }
}

// 尝试调用宿主端 /api 端点（带 cookie 的 RPC 信封）
const rpc = await fetch(`http://${AUTHORITY}/api/bigmodel-usage.config`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie: `${name}=${value}` },
  body: JSON.stringify({ type: 'client-request', rpcId: 'verify-1', method: 'bigmodel-usage.config', payload: {} }),
})
if (rpc.status === 200) {
  const envelope = await rpc.json()
  console.log('PASS  /api/bigmodel-usage.config 端点在线:', JSON.stringify(envelope.result?.value))
} else {
  console.log(`WARN  /api/bigmodel-usage.config 返回 ${rpc.status}（宿主端可能尚未热加载，重启后生效）`)
}
