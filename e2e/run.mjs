// End-to-end check of the built app (`npm run e2e`): a fake OpenAI-compatible provider, the real
// Electron app driven over the Chrome DevTools Protocol. No test framework, no extra packages.
//
// Flow: add a custom provider → new office → goal → approve a command → final report →
// Changes lists the written file → Undo all removes it → a provider out of credit shows the blocked card.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-e2e-'))
const data = path.join(tmp, 'data')
const ws = path.join(tmp, 'workspace')
fs.mkdirSync(ws)

// --- fake provider: the reply depends on what the conversation needs next ---

const call = (name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id: `c${Math.random().toString(36).slice(2)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })

// The "Lite" team: Maya (CEO) delegates to Daniel (engineer), who writes a file, runs a command and reports back.
function reply(messages) {
  const me = /You are (\w+),/.exec(messages[0].content)?.[1]
  const last = messages.at(-1)
  const text = last.role === 'user' ? String(last.content) : ''
  const lastCall = messages.filter((m) => m.role === 'assistant').at(-1)?.tool_calls?.[0]?.function?.name
  if (me === 'Maya') {
    if (text.includes('[From the owner]')) return call('message', { to: ['Daniel'], text: 'Write hello.txt and check Node.' })
    if (text.includes('[From Daniel')) return call('report_to_user', { summary: '## Done\nDaniel wrote `hello.txt` and checked Node.' })
  }
  if (me === 'Daniel') {
    if (text.includes('[From Maya')) return call('write_file', { path: 'hello.txt', content: 'Hello from the team\n' })
    if (lastCall === 'write_file') return call('run_command', { command: 'node --version' })
    if (lastCall === 'run_command') return call('message', { to: ['Maya'], text: 'Done: hello.txt is written.' })
  }
  return { role: 'assistant', content: 'ok' }
}

const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    res.setHeader('content-type', 'application/json')
    if (req.url.endsWith('/models')) return res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model' }] }))
    const { messages } = JSON.parse(body)
    const owner = messages.filter((m) => m.role === 'user').at(-1)?.content ?? ''
    if (typeof owner === 'string' && owner.includes('[From the owner] again')) {
      res.statusCode = 402
      return res.end(JSON.stringify({ error: { message: 'Insufficient Balance', type: 'unknown_error' } }))
    }
    const message = reply(messages)
    res.end(JSON.stringify({ id: 'x', object: 'chat.completion', created: 0, model: 'fake-model', choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 } }))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const providerUrl = `http://127.0.0.1:${server.address().port}/v1`

// --- the app ---

const require_ = (await import('node:module')).createRequire(import.meta.url)
const electron = require_('electron')
const args = [root, '--remote-debugging-port=0', ...(process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [])]
const app = spawn(electron, args, { env: { ...process.env, AI_OFFICE_DATA: data, ELECTRON_ENABLE_LOGGING: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
let appLog = ''
app.stdout.on('data', (d) => (appLog += d))
const devtools = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`The app did not start:\n${appLog}`)), 30_000)
  app.stderr.on('data', (d) => {
    appLog += d
    const m = /DevTools listening on (ws:\/\/[^\s]+)/.exec(appLog)
    if (m) {
      clearTimeout(timer)
      resolve(m[1])
    }
  })
  app.on('exit', (code) => reject(new Error(`The app exited (${code}):\n${appLog}`)))
}).catch((e) => {
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=E2E start::${e.message.replace(/%/g, '%25').replace(/\r/g, '').replace(/\n/g, '%0A')}`)
  server.close()
  throw e
})

const port = new URL(devtools).port
let page
for (let i = 0; i < 50 && !page; i++) {
  page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page')
  if (!page) await new Promise((r) => setTimeout(r, 200))
}
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => socket.addEventListener('open', r))
let seq = 0
const pending = new Map()
socket.addEventListener('message', (m) => {
  const d = JSON.parse(m.data)
  if (d.id && pending.has(d.id)) pending.get(d.id)(d)
})
const cdp = (method, params = {}) => new Promise((r) => (pending.set(++seq, r), socket.send(JSON.stringify({ id: seq, method, params }))))

/** Runs `fn` (source of a function) in the page with `args`; returns its JSON result. */
async function inPage(fn, ...a) {
  const r = await cdp('Runtime.evaluate', { expression: `(${fn})(...${JSON.stringify(a)})`, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'page error')
  return r.result?.result?.value
}

async function until(what, fn, ...a) {
  const end = Date.now() + 30_000
  for (;;) {
    const v = await inPage(fn, ...a).catch(() => undefined)
    if (v) return v
    if (Date.now() > end) throw new Error(`Timed out waiting for: ${what}`)
    await new Promise((r) => setTimeout(r, 200))
  }
}

// Page helpers (sent as source; they run inside the app window).
const clickText = (text) => {
  const el = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === text || b.getAttribute('aria-label') === text)
  if (!el || el.disabled) return false
  el.click()
  return true
}
const fill = (label, value) => {
  const field = [...document.querySelectorAll('label.field')].find((l) => l.querySelector(':scope > span')?.textContent.trim() === label)
  const el = field?.querySelector('input, textarea, select')
  if (!el) return false
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement
  Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(el, value)
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  return true
}
const say = (text) => {
  const el = document.querySelector('.composer-box textarea')
  if (!el) return false
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, text)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return true
}
const hasText = (text) => document.body.innerText.includes(text)

const step = async (name, fn) => {
  process.stdout.write(`• ${name} … `)
  await fn()
  process.stdout.write('ok\n')
}

let failed = false
try {
  await until('the app', () => document.querySelector('.rail') !== null)
  await inPage(() => {
    localStorage.setItem('ai-office.lang', 'en')
    location.reload()
  })
  await until('the app after reload', () => document.querySelector('.rail') !== null)

  await step('add a custom provider', async () => {
    await until('Settings', clickText, 'Settings')
    await until('Add provider', clickText, 'Add provider')
    await until('Other (custom)', clickText, 'Other (custom)')
    await until('name field', fill, 'Name', 'Fake')
    await inPage(fill, 'Base URL', providerUrl)
    await inPage(fill, 'API key', 'test-key')
    await until('Save', clickText, 'Save')
    await until('the provider in the list', hasText, 'Fake')
  })

  await step('create an office', async () => {
    await until('the office menu', clickText, 'Add office')
    await until('New office', clickText, 'New office')
    await until('office name', fill, 'Office name', 'E2E office')
    await inPage(fill, 'Workspace folder', ws)
    await until('the Lite template', () => {
      const b = [...document.querySelectorAll('button.choice')].find((x) => x.querySelector('.t')?.textContent.trim() === 'Lite')
      b?.click()
      return b?.getAttribute('aria-pressed') === 'true'
    })
    await until('model field', fill, 'Default model', 'fake-model')
    await until('Create office', clickText, 'Create office')
    await until('the Work tab', () => {
      const tab = [...document.querySelectorAll('[role=tab]')].find((x) => x.textContent.trim() === 'Work')
      tab?.click()
      return document.querySelector('.composer-box textarea') !== null
    })
  })

  await step('give a goal and approve the command', async () => {
    await until('composer', say, 'Write hello.txt')
    await until('Send', clickText, 'Send')
    await until('the approval card', hasText, 'node --version')
    await until('Allow', clickText, 'Allow')
    await until('the final report', hasText, 'Final report')
    if (fs.readFileSync(path.join(ws, 'hello.txt'), 'utf8') !== 'Hello from the team\n') throw new Error('hello.txt has the wrong content')
  })

  await step('see the change and undo it', async () => {
    await until('Changes', () => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim().startsWith('Changes'))
      b?.click()
      return Boolean(b)
    })
    await until('hello.txt in the changes', () => [...document.querySelectorAll('.changes, aside, [role=dialog], .sheet')].some((e) => e.textContent.includes('hello.txt')))
    await until('Undo all', clickText, 'Undo all')
    await until('confirm undo', clickText, 'Click again to undo')
    const end = Date.now() + 15_000
    while (fs.existsSync(path.join(ws, 'hello.txt'))) {
      if (Date.now() > end) throw new Error('Undo did not remove hello.txt')
      await new Promise((r) => setTimeout(r, 200))
    }
  })

  await step('a provider out of credit stops the member with a clear card', async () => {
    await inPage(() => document.querySelector('.sheet button[aria-label="Close"], .changes button[aria-label="Close"]')?.click())
    await until('composer', say, 'again')
    await until('Send', clickText, 'Send')
    await until('the blocked card', () => document.querySelector('.card.blocked')?.textContent.includes('out of credit'))
  })
} catch (e) {
  failed = true
  console.error(`\nFAILED: ${e.message}`)
  // On GitHub the message and the app's last lines become annotations, readable without the full log.
  if (process.env.GITHUB_ACTIONS) {
    const esc = (s) => s.replace(/%/g, '%25').replace(/\r/g, '').replace(/\n/g, '%0A')
    console.log(`::error title=E2E::${esc(e.message)}`)
    console.log(`::error title=App log::${esc(appLog.split('\n').slice(-25).join('\n'))}`)
  }
  const shot = await cdp('Page.captureScreenshot', { format: 'png' }).catch(() => null)
  if (shot?.result?.data) {
    fs.writeFileSync(path.join(root, 'e2e', 'failure.png'), Buffer.from(shot.result.data, 'base64'))
    console.error('Screenshot: e2e/failure.png')
  }
  console.error(appLog.split('\n').slice(-30).join('\n'))
} finally {
  // Closing the window quits the app the normal way; a hung app is killed after 10 s.
  const exited = new Promise((r) => (app.exitCode !== null ? r() : app.once('exit', r)))
  void cdp('Runtime.evaluate', { expression: 'window.close()' })
  await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))])
  if (app.exitCode === null) app.kill()
  socket.close()
  server.closeAllConnections()
  server.close()
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 })
}
console.log(failed ? 'E2E failed' : 'E2E passed')
process.exit(failed ? 1 : 0)
