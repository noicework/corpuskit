import { getPlatformDomain } from '../../../packages/core/src/platform-domain.ts'

const PLATFORM_DOMAIN_MARKER = '__CORPUSKIT_PLATFORM_DOMAIN__'

/** Replace the shell's non-executable configuration marker without buffering the HTML. */
export function platformShellResponse(response: Response, domain?: string): Response {
  const platformDomain = getPlatformDomain(domain)
  if (!response.body || !response.headers.get('content-type')?.includes('text/html')) {
    return response
  }
  let pending = ''
  const body = response.body.pipeThrough(new TextDecoderStream()).pipeThrough(
    new TransformStream<string, string>({
      transform(chunk, controller) {
        pending += chunk
        let match: number
        while ((match = pending.indexOf(PLATFORM_DOMAIN_MARKER)) !== -1) {
          controller.enqueue(pending.slice(0, match) + platformDomain)
          pending = pending.slice(match + PLATFORM_DOMAIN_MARKER.length)
        }
        // Keep only a possible partial marker across UTF-8 stream chunks.
        const ready = Math.max(0, pending.length - PLATFORM_DOMAIN_MARKER.length + 1)
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
