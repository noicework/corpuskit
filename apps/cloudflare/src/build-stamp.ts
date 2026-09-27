/**
 * The web build's stamp, carried inside the bundled Worker so /api/health can report the commit
 * and release it was built from. `deno task build:worker` replaces this placeholder in
 * dist/cloudflare/worker.js with the base64url JSON of apps/web/dist/build.json
 * (apps/cloudflare/scripts/stamp-worker.ts). Source and tests keep the placeholder, which decodes
 * to no stamp. The health `version` stays the Cloudflare version id, which release verification
 * compares against.
 */
import { type WebBuildStamp, webBuildStamp } from '../../api/src/build-stamp.ts'

export const EMBEDDED_WEB_BUILD = '__CORPUSKIT_WEB_BUILD_STAMP__'

/** Base64url without padding, so the value is safe inside any string literal. */
export function encodeWebBuild(stamp: WebBuildStamp): string {
  const bytes = new TextEncoder().encode(JSON.stringify(stamp))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(
    /=+$/,
    '',
  )
}

export function decodeWebBuild(encoded: string): WebBuildStamp | undefined {
  try {
    const binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'))
    const json = new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)))
    return webBuildStamp(JSON.parse(json))
  } catch {
    return undefined
  }
}

/** The stamp this bundle was built with, or undefined when it was never stamped. */
export function embeddedWebBuild(): WebBuildStamp | undefined {
  return decodeWebBuild(EMBEDDED_WEB_BUILD)
}
