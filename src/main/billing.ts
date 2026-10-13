import type { Price, ProviderKind, Usage } from '../shared/types'

const M = 1e6

/**
 * USD for one request. Unset cache prices fall back to Anthropic's published
 * multipliers, or to the full input price elsewhere (never under-counts).
 */
export function cost(price: Price, kind: ProviderKind, u: Usage): number {
  const prompt = u.in + u.cacheRead + u.cacheWrite
  const tier = price.long && prompt > price.long.above ? price.long : price
  const read = tier.cacheRead ?? (kind === 'anthropic' ? tier.in * 0.1 : tier.in)
  const write = tier.cacheWrite ?? (kind === 'anthropic' ? tier.in * 1.25 : tier.in)
  return (u.in * tier.in + u.cacheRead * read + u.cacheWrite * write + u.out * tier.out) / M
}

export const totalTokens = (u: Usage) => u.in + u.cacheRead + u.cacheWrite + u.out
