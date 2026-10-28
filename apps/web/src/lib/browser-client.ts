/**
 * A public frame may have no persistent storage. Keep one id for this document in that case,
 * shared by access checks and asks, so the existing anonymous ownership boundary still agrees.
 */
export function createBrowserClientId(
  storage: () => Pick<Storage, 'getItem' | 'setItem'> = () => localStorage,
): () => string {
  let current: string | undefined
  return () => {
    try {
      const store = storage()
      const saved = store.getItem('rp-client-id')
      if (saved) return current = saved
      current ??= crypto.randomUUID().replace(/-/g, '')
      store.setItem('rp-client-id', current)
    } catch {
      current ??= crypto.randomUUID().replace(/-/g, '')
    }
    return current
  }
}

export const browserClientId = createBrowserClientId()
