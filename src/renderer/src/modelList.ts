/**
 * Model ids per provider, asked for once. The key includes a version (whether a key is stored) so
 * adding a key fetches the list again; failures are never kept, so the next ask retries.
 */
export function createModelCache(load: (providerId: string) => Promise<string[]>) {
  const cache = new Map<string, Promise<string[]>>()
  const key = (providerId: string, version: string) => JSON.stringify([providerId, version])
  return {
    get(providerId: string, version = ''): Promise<string[]> {
      const k = key(providerId, version)
      let p = cache.get(k)
      if (!p) {
        p = load(providerId)
        cache.set(k, p)
        const mine = p
        mine.catch(() => {
          if (cache.get(k) === mine) cache.delete(k)
        })
      }
      return p
    },
    /** Drops every cached list of this provider (the "reload" button). */
    forget(providerId: string) {
      for (const k of [...cache.keys()]) if ((JSON.parse(k) as string[])[0] === providerId) cache.delete(k)
    }
  }
}
