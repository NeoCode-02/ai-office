import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { classify } from './errors'
import { openChat, speak, transcribe, type ToolDef } from './providers'
import { sttModelFor } from '../shared/voice'

/* eslint-disable @typescript-eslint/no-explicit-any -- request bodies are checked as plain JSON */

type Reply = (res: http.ServerResponse) => void
interface Seen {
  url: string
  headers: http.IncomingHttpHeaders
  body: any
}

const servers: http.Server[] = []
afterEach(() => {
  vi.unstubAllGlobals()
  for (const s of servers.splice(0)) {
    s.closeAllConnections()
    s.close()
  }
})

/** A fake provider: answers each request with the next reply and records what it was sent. */
async function fakeApi(replies: Reply[]) {
  const seen: Seen[] = []
  const server = http.createServer((req, res) => {
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => {
      seen.push({ url: req.url ?? '', headers: req.headers, body: JSON.parse(b) })
      const reply = replies.shift() ?? badRequest
      reply(res)
    })
  })
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { url, seen }
}

const badRequest: Reply = (res) => {
  res.writeHead(400, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'nope' } }))
}

/** Never answers; resolves `arrived` once the request is in. */
function hanging() {
  let arrived!: () => void
  const promise = new Promise<void>((r) => (arrived = r))
  const reply: Reply = () => arrived()
  return { reply, arrived: promise }
}

const tool: ToolDef = { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }

// --- Anthropic (streamed) ---

const sse = (events: object[]) => events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
const start = { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }
const textBlock = (index: number, parts: string[]) => [
  { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
  ...parts.map((text) => ({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } })),
  { type: 'content_block_stop', index }
]
const toolBlock = (index: number, id: string, json: string) => [
  { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name: 'read_file', input: {} } },
  { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json } },
  { type: 'content_block_stop', index }
]
const end = (stop_reason: string) => [
  { type: 'message_delta', delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: 5 } },
  { type: 'message_stop' }
]
const streamed =
  (...events: object[]): Reply =>
  (res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(sse(events))
  }
const hello = streamed(start, ...textBlock(0, ['Hello']), ...end('end_turn'))

const anthropic = (url: string) => ({ kind: 'anthropic' as const, baseURL: url, apiKey: 'k' })

describe('Anthropic adapter', () => {
  it('sends the default reply limit and no effort unless the member has them', async () => {
    const api = await fakeApi([hello, hello])
    await openChat(anthropic(api.url), 'claude-haiku-4-5', 'sys', [tool]).step([], 'hi')
    await openChat(anthropic(api.url), 'claude-opus-5-5', 'sys', [tool], { effort: 'xhigh', maxTokens: 64_000 }).step([], 'hi')

    expect(api.seen[0].body.max_tokens).toBe(32000)
    expect(api.seen[0].body).not.toHaveProperty('output_config')
    expect(api.seen[1].body.max_tokens).toBe(64_000)
    expect(api.seen[1].body.output_config).toEqual({ effort: 'xhigh' })
  })

  it('after a mid-reply fallback uses only what the fallback model wrote, and names it for pricing', async () => {
    const served = { ...start, message: { ...start.message, model: 'claude-opus-5' } }
    const fallback = { type: 'content_block_start', index: 1, content_block: { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' } } }
    const api = await fakeApi([
      streamed(served, ...textBlock(0, ['half']), ...toolBlock(2, 'old', '{"path":"x"}'), fallback, { type: 'content_block_stop', index: 1 }, ...textBlock(3, ['final']), ...toolBlock(4, 'new', '{"path":"y"}'), ...end('tool_use')),
      hello
    ])
    const chat = openChat(anthropic(api.url), 'claude-opus-5-5', 'sys', [tool])
    const turn = await chat.step([], 'hi')
    expect(turn.text).toBe('final')
    expect(turn.calls.map((c) => c.id)).toEqual(['new'])
    expect(turn.model).toBe('claude-opus-5')
    await chat.step([{ id: 'new', content: 'ok' }])
    // The fallback block is echoed back where it was.
    expect(api.seen[1].body.messages[1].content.map((b: { type: string }) => b.type)).toEqual(['text', 'tool_use', 'fallback', 'text', 'tool_use'])
  })

  it('keeps the server-side fallback for the models that support it', async () => {
    const api = await fakeApi([hello, hello])
    await openChat(anthropic(api.url), 'claude-opus-5-5', 'sys', []).step([], 'hi')
    await openChat(anthropic(api.url), 'claude-sonnet-4-6', 'sys', []).step([], 'hi')

    expect(api.seen[0].body.fallbacks).toBe('default')
    expect(api.seen[0].headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01')
    expect(api.seen[1].body).not.toHaveProperty('fallbacks')
    expect(api.seen[1].headers['anthropic-beta']).toBeUndefined()
  })

  it('streams the reply so far, across text blocks, to onText', async () => {
    const api = await fakeApi([streamed(start, ...textBlock(0, ['Hel', 'lo']), ...toolBlock(1, 't1', '{"path":"a.txt"}'), ...textBlock(2, ['Bye']), ...end('tool_use'))])
    const snapshots: string[] = []
    const turn = await openChat(anthropic(api.url), 'm', 'sys', [tool]).step([], 'hi', { onText: (s) => snapshots.push(s) })

    expect(snapshots).toEqual(['Hel', 'Hello', 'Hello\nBye'])
    expect(turn.text).toBe('Hello\nBye')
    expect(turn.calls).toEqual([{ id: 't1', name: 'read_file', input: { path: 'a.txt' } }])
  })

  it('does not fail the request when the live view throws', async () => {
    const api = await fakeApi([hello])
    const onText = vi.fn(() => {
      throw new Error('renderer gone')
    })
    const turn = await openChat(anthropic(api.url), 'm', 'sys', []).step([], 'hi', { onText })
    expect(onText).toHaveBeenCalledWith('Hello')
    expect(turn.text).toBe('Hello')
  })

  it('stops on abort, never retries it, and leaves the history unchanged', async () => {
    const api = await fakeApi([
      (res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(sse([start, ...textBlock(0, ['Partial']).slice(0, 2)])) // then nothing more
      },
      hello
    ])
    const chat = openChat(anthropic(api.url), 'm', 'sys', [])
    const ac = new AbortController()
    const err = await chat.step([], 'hi', { signal: ac.signal, onText: () => ac.abort() }).catch((e: unknown) => e)

    expect(classify(err)).toMatchObject({ kind: 'other', retry: false, aborted: true })
    expect((await chat.step([], 'hi')).text).toBe('Hello')
    expect(api.seen).toHaveLength(2)
    expect(api.seen[1].body.messages).toEqual(api.seen[0].body.messages)
  })

  it('sends nothing when the signal is already aborted', async () => {
    const api = await fakeApi([hello])
    const ac = new AbortController()
    ac.abort()
    const err = await openChat(anthropic(api.url), 'm', 'sys', []).step([], 'hi', { signal: ac.signal }).catch((e: unknown) => e)
    expect(classify(err).aborted).toBe(true)
    expect(api.seen).toHaveLength(0)
  })

  it('never runs a tool call from a cut-off reply and answers it on the next step', async () => {
    const api = await fakeApi([streamed(start, ...toolBlock(0, 't1', '{"pa'), ...end('max_tokens')), hello])
    const chat = openChat(anthropic(api.url), 'm', 'sys', [tool])
    const turn = await chat.step([], 'hi')
    expect(turn.calls).toEqual([])
    expect(turn.text).toBe('(the reply hit the length limit)')

    await chat.step([], 'go on')
    const last = api.seen[1].body.messages.at(-1)
    expect(last.content).toEqual([
      { type: 'tool_result', tool_use_id: 't1', content: 'Not run: the previous reply was cut off', is_error: true },
      { type: 'text', text: 'go on' }
    ])
  })
})

// --- OpenAI-compatible ---

interface ChoiceShape {
  content?: string | null
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  finish_reason?: string
  extra?: Record<string, unknown>
}
const completion =
  ({ content = null, tool_calls, finish_reason = 'stop', extra }: ChoiceShape): Reply =>
  (res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        id: 'c',
        object: 'chat.completion',
        created: 0,
        model: 'm',
        choices: [{ index: 0, message: { role: 'assistant', content, ...(tool_calls ? { tool_calls } : {}), ...extra }, finish_reason }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      })
    )
  }
const ok = completion({ content: 'Done' })
const openai = (baseURL: string) => ({ kind: 'openai' as const, baseURL, apiKey: 'k' })
const call = (id: string, args: string) => ({ id, type: 'function' as const, function: { name: 'read_file', arguments: args } })

const png = { mime: 'image/png', name: 'shot.png', data: 'iVBORw0K' }
const pdf = { mime: 'application/pdf', name: 'spec.pdf', data: 'JVBERi0x' }

describe('speech to text', () => {
  it('posts the recording to /audio/transcriptions with the model and returns the text', async () => {
    let body = ''
    let url = ''
    const server = http.createServer((req, res) => {
      url = req.url ?? ''
      req.setEncoding('latin1')
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ text: ' salom jamoa ' }))
      })
    })
    servers.push(server)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
    expect(await transcribe(openai(base), 'whisper-large-v3-turbo', new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]))).toBe('salom jamoa')
    expect(url).toBe('/v1/audio/transcriptions')
    expect(body).toMatch(/name="model"\r\n\r\nwhisper-large-v3-turbo/)
    expect(body).toMatch(/filename="speech\.webm"/)
    expect(body).toContain('\x1a\x45\xdf\xa3')
  })

  it('gets spoken text as mp3 from /audio/speech', async () => {
    const api = await fakeApi([(res) => {
      res.writeHead(200, { 'content-type': 'audio/mpeg' })
      res.end(Buffer.from([0xff, 0xf3, 1, 2]))
    }])
    const mp3 = await speak(openai(`${api.url}/v1`), 'gpt-4o-mini-tts', 'nova', 'Salom')
    expect([...mp3]).toEqual([0xff, 0xf3, 1, 2])
    expect(api.seen[0].url).toBe('/v1/audio/speech')
    expect(api.seen[0].body).toEqual({ model: 'gpt-4o-mini-tts', voice: 'nova', input: 'Salom', response_format: 'mp3' })
  })

  it('picks a model the provider offers when none is set', () => {
    expect(sttModelFor('https://api.groq.com/openai/v1')).toBe('whisper-large-v3-turbo')
    expect(sttModelFor('https://api.openai.com/v1')).toBe('gpt-4o-mini-transcribe')
    expect(sttModelFor('')).toBe('gpt-4o-mini-transcribe')
    expect(sttModelFor('http://localhost:8000/v1')).toBe('whisper-1')
  })
})

describe('files a tool opened', () => {
  it('Anthropic gets images and PDFs inside the tool result', async () => {
    const api = await fakeApi([hello])
    await openChat(anthropic(api.url), 'm', 'sys', [tool]).step([{ id: 't1', content: 'shown', media: png }, { id: 't2', content: 'shown', media: pdf }, { id: 't3', content: 'text' }])
    const [a, b, c] = api.seen[0].body.messages.at(-1).content
    expect(a.content).toEqual([{ type: 'text', text: 'shown' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0K' } }])
    expect(b.content[1]).toEqual({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0x' } })
    expect(c.content).toBe('text')
  })

  it('OpenAI-compatible APIs get images in one user message after the tool messages, with the owner text', async () => {
    const api = await fakeApi([ok])
    await openChat(openai(`${api.url}/v1`), 'm', 'sys', [tool]).step([{ id: 't1', content: 'shown', media: png }, { id: 't2', content: 'plain' }], 'next')
    const msgs = api.seen[0].body.messages
    expect(msgs.slice(1, 3).map((m: any) => [m.role, m.content])).toEqual([['tool', 'shown'], ['tool', 'plain']])
    expect(msgs[3]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'The files you opened:' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0K' } }, { type: 'text', text: 'next' }]
    })
  })

  it('sends PDFs only where the API takes files, and tells the model otherwise', async () => {
    const other = await fakeApi([ok])
    await openChat(openai(`${other.url}/v1`), 'm', 'sys', [tool]).step([{ id: 't1', content: 'shown', media: pdf }])
    expect(other.seen[0].body.messages.at(-1)).toMatchObject({ role: 'tool', content: expect.stringContaining('cannot show PDF') })

    const api = await fakeApi([ok])
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) => realFetch(String(input).replace('https://api.openai.com', api.url), init))
    await openChat(openai('https://api.openai.com/v1'), 'gpt-x', 'sys', [tool]).step([{ id: 't1', content: 'shown', media: pdf }])
    expect(api.seen[0].body.messages.at(-1).content[1]).toEqual({ type: 'file', file: { filename: 'spec.pdf', file_data: 'data:application/pdf;base64,JVBERi0x' } })
  })
})

describe('OpenAI-compatible adapter', () => {
  it('sends no reply limit unless the member has one, then max_tokens on other hosts', async () => {
    const api = await fakeApi([ok, ok])
    await openChat(openai(`${api.url}/v1`), 'm', 'sys', [tool]).step([], 'hi')
    await openChat(openai(`${api.url}/v1`), 'm', 'sys', [tool], { maxTokens: 500, effort: 'high' }).step([], 'hi')

    expect(api.seen[0].body).not.toHaveProperty('max_tokens')
    expect(api.seen[0].body).not.toHaveProperty('max_completion_tokens')
    expect(api.seen[1].body.max_tokens).toBe(500)
    expect(api.seen[1].body).not.toHaveProperty('max_completion_tokens')
    // effort is an Anthropic setting
    expect(api.seen[1].body).not.toHaveProperty('output_config')
    expect(api.seen[1].body).not.toHaveProperty('reasoning_effort')
  })

  it('sends max_completion_tokens to api.openai.com', async () => {
    const api = await fakeApi([ok])
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) => realFetch(String(input).replace('https://api.openai.com', api.url), init))
    await openChat(openai('https://api.openai.com/v1'), 'gpt-x', 'sys', [tool], { maxTokens: 700 }).step([], 'hi')

    expect(api.seen[0].url).toBe('/v1/chat/completions')
    expect(api.seen[0].body.max_completion_tokens).toBe(700)
    expect(api.seen[0].body).not.toHaveProperty('max_tokens')
  })

  it('leaves out an empty tool list', async () => {
    const api = await fakeApi([ok])
    await openChat(openai(`${api.url}/v1`), 'm', 'sys', []).step([], 'hi')
    expect(api.seen[0].body).not.toHaveProperty('tools')
  })

  it('never runs tool calls from a reply cut off at the length limit and answers them next step', async () => {
    const api = await fakeApi([completion({ tool_calls: [call('c1', '{"path":"a"}'), call('c2', '{"pa')], finish_reason: 'length' }), ok])
    const chat = openChat(openai(`${api.url}/v1`), 'm', 'sys', [tool])
    const onText = vi.fn()
    const turn = await chat.step([], 'hi', { onText })
    expect(turn.calls).toEqual([])
    expect(turn.text).toBe('(the reply hit the length limit)')
    expect(onText).not.toHaveBeenCalled()

    expect((await chat.step([], 'go on')).text).toBe('Done')
    const msgs = api.seen[1].body.messages
    expect(msgs.slice(2)).toEqual([
      // broken arguments are replayed as {} so strict servers accept the history
      { role: 'assistant', content: null, tool_calls: [call('c1', '{"path":"a"}'), call('c2', '{}')] },
      { role: 'tool', tool_call_id: 'c1', content: 'Not run: the previous reply was cut off' },
      { role: 'tool', tool_call_id: 'c2', content: 'Not run: the previous reply was cut off' },
      { role: 'user', content: 'go on' }
    ])
  })

  it('keeps unanswered cut-off calls and the history when the next step fails', async () => {
    const api = await fakeApi([completion({ content: 'Partial', tool_calls: [call('c1', '{}')], finish_reason: 'length' }), badRequest, ok])
    const chat = openChat(openai(`${api.url}/v1`), 'm', 'sys', [tool])
    expect((await chat.step([], 'hi')).text).toBe('Partial')
    await expect(chat.step([], 'go on')).rejects.toThrow()
    await chat.step([], 'go on')

    expect(api.seen[2].body.messages).toEqual(api.seen[1].body.messages)
    expect(api.seen[2].body.messages.filter((m: { role: string }) => m.role === 'tool')).toHaveLength(1)
  })

  it('replays the reply as returned, extra fields included', async () => {
    const api = await fakeApi([completion({ content: '', tool_calls: [call('c1', '{"path":"x"}')], finish_reason: 'tool_calls', extra: { reasoning_content: 'thinking' } }), ok])
    const chat = openChat(openai(`${api.url}/v1`), 'm', 'sys', [tool])
    const turn = await chat.step([], 'hi')
    expect(turn.calls).toEqual([{ id: 'c1', name: 'read_file', input: { path: 'x' } }])

    await chat.step([{ id: 'c1', content: 'file text' }])
    expect(api.seen[1].body.messages.slice(2)).toEqual([
      { role: 'assistant', content: '', tool_calls: [call('c1', '{"path":"x"}')], reasoning_content: 'thinking' },
      { role: 'tool', tool_call_id: 'c1', content: 'file text' }
    ])
  })

  it('reports broken tool arguments to the tool validator but replays them as {}', async () => {
    const api = await fakeApi([completion({ tool_calls: [call('c1', 'not json'), call('c2', '[1]')], finish_reason: 'tool_calls' }), ok])
    const chat = openChat(openai(`${api.url}/v1`), 'm', 'sys', [tool])
    const turn = await chat.step([], 'hi')
    expect(turn.calls).toEqual([
      { id: 'c1', name: 'read_file', input: { __invalid_json: 'not json' } },
      { id: 'c2', name: 'read_file', input: {} }
    ])

    await chat.step([{ id: 'c1', content: 'bad', isError: true }, { id: 'c2', content: 'bad', isError: true }])
    expect(api.seen[1].body.messages[2].tool_calls).toEqual([call('c1', '{}'), call('c2', '{}')])
  })

  it('stops on abort, never retries it, and leaves the history unchanged', async () => {
    const wait = hanging()
    const api = await fakeApi([wait.reply, ok])
    const chat = openChat(openai(`${api.url}/v1`), 'm', 'sys', [])
    const ac = new AbortController()
    const pending = chat.step([], 'hi', { signal: ac.signal }).catch((e: unknown) => e)
    await wait.arrived
    ac.abort()

    expect(classify(await pending)).toMatchObject({ kind: 'other', retry: false, aborted: true })
    expect((await chat.step([], 'hi')).text).toBe('Done')
    expect(api.seen).toHaveLength(2)
    expect(api.seen[1].body.messages).toEqual(api.seen[0].body.messages)
  })
})
