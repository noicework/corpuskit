import { expect } from '@std/expect'
import { type AuditEvent, type AuditInput, AuditWriteError, redactAuditDetail } from './audit.ts'
import {
  AUDIT_MAX_RESPONSE_BYTES,
  AUDIT_TIMEOUT_MS,
  executeAudited,
  executeAuditedResponse,
} from './audit-execution.ts'

const input: Omit<AuditInput, 'outcome'> = {
  requestId: 'request-1',
  actor: { kind: 'user', id: 'oid-1' },
  action: 'request.privileged',
  scope: { kind: 'portal', slug: 'marine' },
  target: { kind: 'request', id: 'document-1' },
  detail: { permission: 'portal.generate', method: 'POST' },
}
function harness(failAt = 0) {
  const events: AuditEvent[] = []
  const logs: unknown[] = []
  let appends = 0
  return {
    input,
    privileged: true,
    events,
    logs,
    log: (message: unknown) => logs.push(message),
    audit: {
      append(event: AuditEvent) {
        if (++appends === failAt) throw new Error('private-store-fixture')
        events.push(event)
      },
    },
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

Deno.test('mandatory intent failure has zero effects and completion failure never replays', async () => {
  for (const failAt of [1, 2]) {
    const fixture = harness(failAt)
    let effects = 0
    const response = await executeAuditedResponse({
      ...fixture,
      run: () => {
        effects++
        return new Response('result', { headers: { 'x-private': 'never-release' } })
      },
    })
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'audit_write_failed' })
    expect(response.headers.has('x-private')).toBe(false)
    expect(effects).toBe(failAt - 1)
    expect(JSON.stringify(fixture.logs)).not.toContain('private-store-fixture')
    expect(fixture.logs).toHaveLength(1)
  }
  await expect(executeAudited({ ...harness(1), run: () => 1 })).rejects.toBeInstanceOf(
    AuditWriteError,
  )
})

Deno.test('headers and staged body release only after successful completion audit', async () => {
  const fixture = harness()
  const ready = deferred<void>()
  let producer!: ReadableStreamDefaultController<Uint8Array>
  let released = false
  const pending = executeAuditedResponse({
    ...fixture,
    run: () =>
      new Response(
        new ReadableStream({
          start(controller) {
            producer = controller
            ready.resolve()
          },
        }),
        { status: 201, headers: { 'x-result': 'complete' } },
      ),
  }).then((response) => {
    released = true
    return response
  })
  await ready.promise
  producer.enqueue(new TextEncoder().encode('first'))
  await Promise.resolve()
  expect(released).toBe(false)
  expect(fixture.events.map((event) => event.outcome)).toEqual(['intent'])
  producer.close()
  const response = await pending
  expect(fixture.events.map((event) => event.outcome)).toEqual(['intent', 'success'])
  expect(response.status).toBe(201)
  expect(response.headers.get('x-result')).toBe('complete')
  expect(await response.text()).toBe('first')
})

Deno.test('byte cap accepts exactly 1 MiB and refuses one extra UTF-8 byte', async () => {
  expect(AUDIT_MAX_RESPONSE_BYTES).toBe(1024 * 1024)
  for (const extra of [0, 1]) {
    const fixture = harness()
    const body = 'é'.repeat(AUDIT_MAX_RESPONSE_BYTES / 2) + 'x'.repeat(extra)
    const response = await executeAuditedResponse({ ...fixture, run: () => new Response(body) })
    expect(response.status).toBe(extra ? 500 : 200)
    expect(fixture.events.at(-1)?.outcome).toBe(extra ? 'uncertain' : 'success')
    if (extra) expect(await response.json()).toEqual({ error: 'response_too_large' })
    else expect((await response.arrayBuffer()).byteLength).toBe(AUDIT_MAX_RESPONSE_BYTES)
  }
})

Deno.test('overflow cancels the reader and upstream signal without replay', async () => {
  const fixture = harness()
  let upstream!: AbortSignal
  let cancelled = 0
  const response = await executeAuditedResponse({
    ...fixture,
    maxBytes: 4,
    run: (signal) => {
      upstream = signal
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(5))
          },
          cancel() {
            cancelled++
          },
        }),
      )
    },
  })
  expect(response.status).toBe(500)
  expect(cancelled).toBe(1)
  expect(upstream.aborted).toBe(true)
  expect(JSON.parse(fixture.events.at(-1)!.detail_json).code).toBe('response_too_large')
})

Deno.test('120 second deadline covers dispatch and blocked streaming, with observed late failures', async () => {
  expect(AUDIT_TIMEOUT_MS).toBe(120_000)
  for (const stream of [false, true]) {
    const fixture = harness()
    const ready = deferred<void>()
    const remote = deferred<Response>()
    let deadline!: () => void
    let disposed = 0
    let upstream!: AbortSignal
    let cancelled = 0
    const pending = executeAuditedResponse({
      ...fixture,
      schedule: (callback, ms) => {
        expect(ms).toBe(120_000)
        deadline = callback
        return () => {
          disposed++
        }
      },
      run: (signal) => {
        upstream = signal
        ready.resolve()
        return stream
          ? new Response(
            new ReadableStream({
              cancel() {
                cancelled++
              },
            }),
          )
          : remote.promise
      },
    })
    await ready.promise
    deadline()
    const response = await pending
    expect(await response.json()).toEqual({ error: 'deadline_exceeded' })
    expect(response.status).toBe(500)
    expect(upstream.aborted).toBe(true)
    expect(disposed).toBe(1)
    expect(fixture.events.at(-1)?.outcome).toBe('uncertain')
    if (stream) expect(cancelled).toBe(1)
    else remote.reject(new Error('private-late-fixture'))
    await Promise.resolve()
  }
})

Deno.test('client abort cancels producer, and an already aborted request never dispatches', async () => {
  for (const before of [false, true]) {
    const fixture = harness()
    const client = new AbortController()
    const ready = deferred<void>()
    let effects = 0
    let cancelled = 0
    if (before) client.abort('private-abort-fixture')
    const pending = executeAuditedResponse({
      ...fixture,
      signal: client.signal,
      run: () => {
        effects++
        ready.resolve()
        return new Response(
          new ReadableStream({
            cancel() {
              cancelled++
            },
          }),
        )
      },
    })
    if (!before) {
      await ready.promise
      client.abort('private-abort-fixture')
    }
    const response = await pending
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'client_aborted' })
    expect(effects).toBe(before ? 0 : 1)
    expect(cancelled).toBe(before ? 0 : 1)
    expect(JSON.stringify(fixture.events)).not.toContain('private-abort-fixture')
  }
})

Deno.test('HTTP errors, SSE error events and MCP logical errors record failed outcomes', async () => {
  for (
    const [body, type, status, outcome] of [
      ['failure', 'text/plain', 500, 'failure'],
      ['denied', 'text/plain', 403, 'denied'],
      ['event: error\ndata: {}\n\n', 'text/event-stream', 200, 'failure'],
      [
        'data: {"type":"error","message":"private-fixture"}\n\n',
        'text/event-stream',
        200,
        'failure',
      ],
      ['{"result":{"isError":true}}', 'application/json', 200, 'failure'],
      ['{invalid', 'application/json', 200, 'failure'],
      ['{"error":"not_found"}', 'application/json', 200, 'failure'],
    ] as const
  ) {
    const fixture = harness()
    const response = await executeAuditedResponse({
      ...fixture,
      run: () =>
        new Response(body, {
          status,
          headers: { 'content-type': type },
        }),
    })
    expect(response.status).toBe(status)
    expect(fixture.events.at(-1)?.outcome).toBe(outcome)
    expect(JSON.stringify(fixture.events)).not.toContain('private-fixture')
  }
})

Deno.test('ordinary ask bypasses staging while break-glass cannot bypass it', async () => {
  const ordinary = harness(1)
  const body = new ReadableStream<Uint8Array>()
  const original = new Response(body)
  const response = await executeAuditedResponse({
    ...ordinary,
    privileged: false,
    run: () => original,
  })
  expect(response).toBe(original)
  expect(ordinary.events).toHaveLength(0)
  await body.cancel()
  let effects = 0
  const emergency = await executeAuditedResponse({
    ...harness(1),
    privileged: false,
    input: { ...input, actor: { kind: 'break-glass' } },
    run: () => {
      effects++
      return new Response('must not run')
    },
  })
  expect(emergency.status).toBe(500)
  expect(effects).toBe(0)
})

Deno.test('generic execution preserves correlation and logs no remote error text', async () => {
  const fixture = harness()
  await expect(executeAudited({
    ...fixture,
    run: () => {
      throw new Error('private-remote-fixture')
    },
  })).rejects.toThrow('operation_failed')
  expect(fixture.events.map((event) => event.outcome)).toEqual(['intent', 'uncertain'])
  expect(fixture.events.every((event) => event.request_id === 'request-1')).toBe(true)
  expect(JSON.stringify(fixture.events)).not.toContain('private-remote-fixture')
})

Deno.test('declared metadata retains field names and session co-attribution without values', async () => {
  const fixture = harness()
  const mutable = {
    ...input,
    actor: { kind: 'break-glass' as const },
    detail: {
      permission: 'appearance.write',
      sessionOid: 'oid-1',
      sessionTenantId: 'tenant-1',
      operation: 'PATCH /api/admin/tenants/:slug',
      changedFields: 'name,colours',
      name: 'private-fixture',
      body: { colours: 'private-fixture' },
    },
  }
  await executeAudited({
    ...fixture,
    input: mutable,
    run: () => {
      mutable.detail.sessionOid = 'changed'
      return 1
    },
  })
  for (const event of fixture.events) {
    expect(event.actor_kind).toBe('break-glass')
    expect(JSON.parse(event.detail_json).sessionOid).toBe('oid-1')
    expect(JSON.parse(event.detail_json).changedFields).toBe('name,colours')
    expect(event.detail_json).not.toContain('private-fixture')
  }
  for (
    const detail of [
      { operation: 'POST /api/unknown' },
      { changedFields: 'name,password' },
      { suggestionKind: 'private-fixture' },
      { from: 'https://secret.test/token' },
    ]
  ) expect(() => redactAuditDetail('request.privileged', detail)).toThrow(AuditWriteError)
})

Deno.test('failed failure-audit returns audit failure and late responses cancel their body', async () => {
  const broken = harness(2)
  const response = await executeAuditedResponse({
    ...broken,
    run: () => {
      throw new Error('remote')
    },
  })
  expect(await response.json()).toEqual({ error: 'audit_write_failed' })
  const fixture = harness()
  const ready = deferred<void>()
  const remote = deferred<Response>()
  let deadline!: () => void
  const cancelled = deferred<void>()
  const pending = executeAuditedResponse({
    ...fixture,
    schedule: (callback) => {
      deadline = callback
      return () => {}
    },
    run: () => {
      ready.resolve()
      return remote.promise
    },
  })
  await ready.promise
  deadline()
  expect((await pending).status).toBe(500)
  remote.resolve(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled.resolve()
        },
      }),
    ),
  )
  await cancelled.promise
  expect(fixture.events.map((event) => event.outcome)).toEqual(['intent', 'uncertain'])
})

Deno.test('reader rejection and cancellation rejection cannot release success or leak reasons', async () => {
  for (const errored of [false, true]) {
    const fixture = harness()
    const response = await executeAuditedResponse({
      ...fixture,
      maxBytes: 1,
      run: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              if (errored) controller.error(new Error('private-reader-fixture'))
              else controller.enqueue(new Uint8Array(2))
            },
            cancel() {
              return Promise.reject(new Error('private-cancel-fixture'))
            },
          }),
        ),
    })
    expect(response.status).toBe(500)
    expect(fixture.events.at(-1)?.outcome).toBe('uncertain')
    expect(JSON.stringify(fixture.events)).not.toContain('private-')
  }
})

Deno.test('real tightened deadline stays bounded when producer cancellation never resolves', async () => {
  const fixture = harness()
  let cancelled = 0
  const response = await executeAuditedResponse({
    ...fixture,
    timeoutMs: 5,
    run: () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled++
            return new Promise<void>(() => {})
          },
        }),
      ),
  })
  expect(await response.json()).toEqual({ error: 'deadline_exceeded' })
  expect(cancelled).toBe(1)
  expect(fixture.events.at(-1)?.outcome).toBe('uncertain')
})

Deno.test('SSE logical errors split across byte chunks are classified after complete staging', async () => {
  const fixture = harness()
  const body = new TextEncoder().encode('data: {"type":"error","message":"é"}\r\n\r\n')
  const response = await executeAuditedResponse({
    ...fixture,
    run: () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const byte of body) controller.enqueue(new Uint8Array([byte]))
            controller.close()
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  })
  expect(response.status).toBe(200)
  expect(fixture.events.at(-1)?.outcome).toBe('failure')
  expect(await response.text()).toBe(new TextDecoder().decode(body))
})
