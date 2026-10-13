import { describe, expect, it } from 'vitest'
import { classify } from './errors'

const api = (status: number | undefined, error: unknown, message = '', headers: Record<string, string> = {}) => ({
  status,
  error,
  message,
  headers: new Headers(headers)
})

describe('classify', () => {
  it('waits on rate limits and honours retry-after', () => {
    expect(classify(api(429, { type: 'error', error: { type: 'rate_limit_error', message: 'Number of request tokens has exceeded your per-minute rate limit' } }, '429', { 'retry-after': '12' }))).toMatchObject({ kind: 'rate', retry: true, retryAfterMs: 12000 })
    expect(classify(api(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }))).toMatchObject({ kind: 'rate', retry: true })
    expect(classify(api(429, { code: '1302', message: 'High concurrency' }))).toMatchObject({ kind: 'rate', retry: true })
  })

  it('treats Gemini per-minute "quota" as a rate limit with its retry delay', () => {
    const body = { code: 429, message: 'You exceeded your current quota', status: 'RESOURCE_EXHAUSTED', details: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }, { retryDelay: '34s' }] }
    expect(classify(api(429, body))).toMatchObject({ kind: 'rate', retry: true, retryAfterMs: 34000 })
  })

  it('does not retry when money or quota ran out', () => {
    expect(classify(api(429, { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', code: 'insufficient_quota' }))).toMatchObject({ kind: 'quota', retry: false })
    expect(classify(api(402, { error: { message: 'Insufficient Balance' } }))).toMatchObject({ kind: 'quota' })
    expect(classify(api(400, { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } }))).toMatchObject({ kind: 'quota' })
    expect(classify(api(429, { code: '1113', message: 'Insufficient balance or no resource package.' }))).toMatchObject({ kind: 'quota' })
    expect(classify(api(429, { code: '1308', message: 'Usage limit reached for 5 hour.' }))).toMatchObject({ kind: 'quota' })
    expect(classify(api(429, { message: 'Your account org-x is suspended', type: 'exceeded_current_quota_error' }))).toMatchObject({ kind: 'quota' })
  })

  it('recognises bad keys, missing models and full context', () => {
    expect(classify(api(401, { error: { type: 'authentication_error', message: 'invalid x-api-key' } }))).toMatchObject({ kind: 'auth' })
    expect(classify(api(400, [{ error: { code: 400, message: 'API key not valid. Please pass a valid API key.' } }]))).toMatchObject({ kind: 'auth' })
    expect(classify(api(404, { error: { type: 'not_found_error', message: 'model: claude-x' } }))).toMatchObject({ kind: 'model' })
    expect(classify(api(400, { message: "This model's maximum context length is 128000 tokens", code: 'context_length_exceeded' }))).toMatchObject({ kind: 'context' })
  })

  it('retries server and network failures', () => {
    expect(classify(api(503, null, 'Service Unavailable'))).toMatchObject({ kind: 'server', retry: true })
    expect(classify(Object.assign(new Error('Connection error.'), { status: undefined }))).toMatchObject({ kind: 'network', retry: true })
    expect(classify(new Error('Request timed out.'))).toMatchObject({ kind: 'network', retry: true })
  })

  it('keeps app error codes and unknown errors as they are', () => {
    expect(classify(new Error('E_KEY_UNREADABLE|DeepSeek'))).toEqual({ kind: 'config', retry: false, detail: 'E_KEY_UNREADABLE|DeepSeek' })
    expect(classify(api(400, { message: 'tools.0: bad schema' }, '400 tools.0: bad schema'))).toMatchObject({ kind: 'other', retry: false, detail: '400 tools.0: bad schema' })
  })
})
