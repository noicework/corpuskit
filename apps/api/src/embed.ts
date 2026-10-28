import { DEFAULT_PALETTES, paletteFromColours, type TenantConfig } from '@research-portal/core'
import type { Context, Next } from 'hono'
import type { TenantStoreApi } from './tenants.ts'
import { embedLoader } from './embed-loader.ts'

/** The one public shell boundary that may be framed. An exact match avoids relaxing subroutes. */
export function embedPath(pathname: string): { slug: string; script: boolean } | null {
  const match = /^\/t\/([a-z0-9][a-z0-9-]*)\/embed(\.js)?$/.exec(pathname)
  return match ? { slug: match[1]!, script: !!match[2] } : null
}

export function embedFramePolicy(config: Pick<TenantConfig, 'embedding'> | undefined): string {
  const settings = config?.embedding
  return settings?.enabled && settings.allowedOrigins.length
    ? `frame-ancestors ${settings.allowedOrigins.join(' ')}`
    : "frame-ancestors 'none'"
}

export function embedPolicyForResponse(
  request: Request,
  response: Response,
  tenants: Pick<TenantStoreApi, 'get' | 'isDisabled'>,
): string {
  const path = embedPath(new URL(request.url).pathname)
  if (!path || path.script || response.status !== 200) return "frame-ancestors 'none'"
  try {
    if (tenants.isDisabled(path.slug)) return "frame-ancestors 'none'"
    return embedFramePolicy(tenants.get(path.slug))
  } catch {
    return "frame-ancestors 'none'"
  }
}

/** Run inside the declared /t/* public shell route. Research still uses guarded /api routes. */
export async function handleEmbedRequest(c: Context, next: Next, options: {
  tenants: Pick<TenantStoreApi, 'get' | 'isDisabled'>
  shell?: (request: Request) => Promise<Response>
}) {
  const path = embedPath(c.req.path)
  if (!path) return next()
  c.header('Cache-Control', 'private, no-store')
  c.header('X-Robots-Tag', 'noindex, nofollow')
  if (!['GET', 'HEAD'].includes(c.req.method)) return c.text('Method not allowed', 405)
  const config = options.tenants.get(path.slug)
  if (!config?.embedding?.enabled || options.tenants.isDisabled(path.slug)) {
    return c.text('Not found', 404)
  }
  if (path.script) {
    const branding = config.branding
    const palette = (branding.paletteId && branding.paletteId !== 'default' &&
      DEFAULT_PALETTES[branding.paletteId].palette) ||
      paletteFromColours(branding.colours) || DEFAULT_PALETTES.corpuskit.palette
    const settings = {
      name: branding.productName,
      tokens: {
        '--rp-primary': palette.brandSurface,
        '--rp-on-primary': palette.onBrandSurface,
        '--rp-focus': palette.focusRing,
        '--rp-field': palette.ink3,
        '--rp-app': palette.paper,
        '--rp-ink': palette.ink,
        '--rp-radius': !branding.shape || branding.shape === 'square'
          ? '0px'
          : branding.shape === 'soft'
          ? '16px'
          : '10px',
        '--rp-radius-btn': !branding.shape || branding.shape === 'square'
          ? '0px'
          : branding.shape === 'soft'
          ? '9999px'
          : '8px',
      },
    }
    c.header('Content-Type', 'text/javascript; charset=utf-8')
    return c.body(`(${embedLoader.toString()})(${JSON.stringify(settings)});`)
  }
  if (options.shell) {
    const response = await options.shell(c.req.raw)
    c.res = response
  } else await next()
  // The private sign-in view receives safe metadata without layout. Carry only its credit
  // choice in the public shell, so that view honours the same footer policy as the portal.
  if (c.res.status === 200 && c.res.headers.get('content-type')?.includes('text/html')) {
    const response = c.res
    const footer = config.branding.layout?.footer
    const credit = !footer || footer.poweredBy ? 'on' : 'off'
    const html = (await response.text()).replace(
      /<head(?:\s[^>]*)?>/i,
      (head) => `${head}<meta name="corpuskit-embed-credit" content="${credit}">`,
    )
    const headers = new Headers(response.headers)
    headers.delete('content-length')
    headers.delete('content-encoding')
    c.res = new Response(html, { status: response.status, headers })
  }
  c.header('Cache-Control', 'private, no-store')
  c.header('X-Robots-Tag', 'noindex, nofollow')
  return c.res
}
