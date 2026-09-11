import { expect } from '@std/expect'
import type { TenantPatch } from './tenants.ts'
import { tenantConfig, TenantStore } from './tenants.ts'

function fixture(raw?: unknown) {
  const directory = Deno.makeTempDirSync({ prefix: 'access-modes-' })
  const path = `${directory}/tenants.json`
  if (raw !== undefined) Deno.writeTextFileSync(path, JSON.stringify(raw))
  return {
    path,
    open: () => new TenantStore({ TENANTS_PATH: path }),
    close: () => Deno.removeSync(directory, { recursive: true }),
  }
}

Deno.test('local access policy persists every mode across repeated reloads and disabled portals', () => {
  const f = fixture()
  try {
    const store = f.open()
    const custom = store.add({ name: 'Custom' })
    expect(custom.accessMode).toBe('public')
    for (const slug of ['marine', custom.slug]) {
      for (const accessMode of ['public', 'authenticated', 'restricted'] as const) {
        store.patch(slug, { accessMode })
        store.setDisabled(slug, true)
        for (let repeat = 0; repeat < 2; repeat++) {
          const loaded = f.open()
          expect(loaded.get(slug)?.accessMode).toBe(accessMode)
          expect(loaded.get(slug)?.branding).toEqual(store.get(slug)?.branding)
          expect(loaded.isDisabled(slug)).toBe(true)
          expect(loaded.list().some((item) => item.slug === slug)).toBe(false)
          expect(loaded.list(true).some((item) => item.slug === slug)).toBe(true)
        }
      }
    }
  } finally {
    f.close()
  }
})

Deno.test('legacy custom and seed overrides default public without losing other fields', () => {
  const config = { ...tenantConfig('marine'), slug: 'legacy', accessMode: undefined }
  for (const raw of [{ legacy: config }, { custom: { legacy: config }, overrides: {} }]) {
    const f = fixture(raw)
    try {
      expect(f.open().get('legacy')?.accessMode).toBe('public')
      expect(f.open().get('marine')?.accessMode).toBe('public')
      expect(f.open().get('legacy')?.topics).toEqual(config.topics)
    } finally {
      f.close()
    }
  }
})

Deno.test('corrupt local policy is unavailable without seed fallback or loss during unrelated writes', () => {
  const bad = [null, 'private', false, {}, []]
  for (const value of bad) {
    for (
      const raw of [
        { custom: { marine: { ...tenantConfig('marine'), accessMode: value } }, overrides: {} },
        { custom: {}, overrides: { marine: { accessMode: value } } },
        ...(value && typeof value === 'object' && !Array.isArray(value)
          ? []
          : [{ custom: {}, overrides: { marine: value } }]),
      ]
    ) {
      const f = fixture(raw)
      try {
        for (let repeat = 0; repeat < 2; repeat++) {
          const store = f.open()
          expect(() => store.get('marine')).toThrow()
          expect(store.list(true).some((item) => item.slug === 'marine')).toBe(false)
          expect(store.get('grains')?.accessMode).toBe('public')
          store.patch('grains', { searchPlaceholder: 'Still available' })
        }
      } finally {
        f.close()
      }
    }
  }
})

Deno.test('invalid patch cannot replace an existing restricted policy', () => {
  const f = fixture()
  try {
    const store = f.open()
    store.patch('marine', { accessMode: 'restricted' })
    for (const patch of [{ accessMode: null }, { accessMode: 'private' }, null, []]) {
      expect(() => store.patch('marine', patch as unknown as TenantPatch)).toThrow()
      expect(f.open().get('marine')?.accessMode).toBe('restricted')
    }
  } finally {
    f.close()
  }
})

Deno.test('malformed persisted root never becomes public defaults on restart', () => {
  for (const raw of [null, [], { custom: null }, { custom: {}, overrides: [] }]) {
    const f = fixture(raw)
    try {
      expect(() => f.open()).toThrow()
      expect(() => f.open()).toThrow()
    } finally {
      f.close()
    }
  }
  const f = fixture()
  try {
    Deno.writeTextFileSync(f.path, '{broken')
    expect(() => f.open()).toThrow()
    expect(() => f.open()).toThrow()
  } finally {
    f.close()
  }
})
