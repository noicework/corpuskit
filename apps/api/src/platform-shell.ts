import {
  getPlatformDomain,
  HOST_PORTAL_MARKER,
  PLATFORM_DOMAIN_MARKER,
} from '../../../packages/core/src/platform-domain.ts'

const PORTAL_SLUG = /^[A-Za-z0-9_-]{1,64}$/

/**
 * Replace the shell's non-executable configuration markers without buffering the HTML: the
 * platform domain, and the portal whose alias host served the page (empty on every other host).
 */
export function platformShellResponse(
  response: Response,
  domain: string,
  hostPortal?: string,
): Response {
  const platformDomain = getPlatformDomain(domain)
  if (!response.body || !response.headers.get('content-type')?.includes('text/html')) {
    return response
  }
  const values = new Map([
    [PLATFORM_DOMAIN_MARKER, platformDomain],
    [HOST_PORTAL_MARKER, hostPortal && PORTAL_SLUG.test(hostPortal) ? hostPortal : ''],
  ])
  const longest = Math.max(...[...values.keys()].map((marker) => marker.length))
  let pending = ''
  const body = response.body.pipeThrough(new TextDecoderStream()).pipeThrough(
    new TransformStream<string, string>({
      transform(chunk, controller) {
        pending += chunk
        for (;;) {
          let found: { at: number; marker: string } | undefined
          for (const marker of values.keys()) {
            const at = pending.indexOf(marker)
            if (at !== -1 && (!found || at < found.at)) found = { at, marker }
          }
          if (!found) break
          controller.enqueue(pending.slice(0, found.at) + values.get(found.marker)!)
          pending = pending.slice(found.at + found.marker.length)
        }
        // Keep only a possible partial marker across UTF-8 stream chunks.
        const ready = Math.max(0, pending.length - longest + 1)
        if (ready) controller.enqueue(pending.slice(0, ready))
        pending = pending.slice(ready)
      },
      flush(controller) {
        if (pending) controller.enqueue(pending)
      },
    }),
  ).pipeThrough(new TextEncoderStream())
  const headers = new Headers(response.headers)
  for (const name of ['content-length', 'etag', 'content-md5']) headers.delete(name)
  headers.set('cache-control', 'no-store')
  return new Response(body, { status: response.status, statusText: response.statusText, headers })
}
