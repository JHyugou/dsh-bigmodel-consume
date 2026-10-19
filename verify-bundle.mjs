import { createHash, createHmac } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const AUTHORITY = '127.0.0.1:19387'
const b64url = (buf) => Buffer.from(buf).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
const unb64url = (v) => { const p = '='.repeat((4 - v.length % 4) % 4); return Buffer.from(v.replaceAll('-', '+').replaceAll('_', '/') + p, 'base64') }
const cred = await readFile(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
const secret = unb64url(cred.split(/\r?\n/).find(l => l.includes('secret:')).split('secret:')[1].trim())
const name = `dsh-auth-${b64url(createHash('sha256').update(AUTHORITY).digest())}`
const issuedAt = Date.now()
const body = b64url(Buffer.from(JSON.stringify({ version: 1, authority: AUTHORITY, issuedAt, expiresAt: issuedAt + 2592000000 })))
const cookie = `${name}=v1.${body}.${b64url(createHmac('sha256', secret).update(body).digest())}`

const html = await (await fetch(`http://${AUTHORITY}/`, { headers: { cookie } })).text()
const row = html.match(/"id":"dsh-bigmodel-consume","url":"([^"]+)","rev":"[^"]*","inject":\[([^\]]*)\]/)
if (!row) { console.log('FAIL: 启动图无插件行'); process.exit(1) }
console.log('inject 声明:', row[2])
const url = `http://${AUTHORITY}/${row[1]}`
const res = await fetch(url, { headers: { cookie } })
const text = await res.text()
console.log('bundle url:', url)
console.log('status:', res.status, 'bytes:', text.length)
console.log(text.includes('window.__ModuleLoader__.load') && text.includes('dsh-bigmodel-consume')
  ? 'PASS: bundle 内容校验通过（ModuleLoader 注册 + 包名一致）'
  : 'FAIL: bundle 内容异常')
console.log('包含 conversation.input.right 注册:', text.includes('conversation.input.right') ? 'PASS' : 'FAIL')
console.log('包含 modelDirectories 注入:', text.includes('modelDirectories') ? 'PASS' : 'FAIL')
console.log('旧侧栏注册已移除:', text.includes('sidebar.footer.action') ? 'FAIL（仍存在）' : 'PASS')
console.log('head:', text.slice(0, 100).replace(/\n/g, ' '))
