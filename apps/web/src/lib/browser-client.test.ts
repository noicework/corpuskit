import { expect } from '@std/expect'
import { createBrowserClientId } from './browser-client.ts'

Deno.test('a storage-blocked frame keeps one guest id without writing a credential', () => {
  const id = createBrowserClientId(() => {
    throw new DOMException('Blocked', 'SecurityError')
  })
  expect(id()).toMatch(/^[a-f0-9]{32}$/)
  expect(id()).toBe(id())
  expect(
    createBrowserClientId(() => {
      throw new Error('Blocked')
    })(),
  ).not.toBe(id())
})

Deno.test('a write-blocked frame and a later storage withdrawal retain the observed id', () => {
  const id = createBrowserClientId(() => ({
    getItem: () => null,
    setItem: () => {
      throw new Error('Blocked')
    },
  }))
  expect(id()).toBe(id())
  let blocked = false
  const observed = createBrowserClientId(() => {
    if (blocked) throw new Error('Blocked')
    return { getItem: () => 'existing-browser-id', setItem: () => {} }
  })
  expect(observed()).toBe('existing-browser-id')
  blocked = true
  expect(observed()).toBe('existing-browser-id')
})
