/**
 * Carries the web build's stamp into the bundled Worker: replaces the placeholder in
 * dist/cloudflare/worker.js with apps/web/dist/build.json, encoded. Run by
 * `deno task build:worker` after bundling. Without a stamp (build:worker run before build:web)
 * it leaves the placeholder, and the Worker reports no build stamp.
 */
import { webBuildStamp } from '../../api/src/build-stamp.ts'
import { EMBEDDED_WEB_BUILD, encodeWebBuild } from '../src/build-stamp.ts'

/** The bundle with its one placeholder replaced; throws if there is not exactly one. */
export function stampBundle(bundle: string, buildJson: string): string {
  const stamp = webBuildStamp(JSON.parse(buildJson))
  if (!stamp) throw new Error('apps/web/dist/build.json is not a build stamp')
  const found = bundle.split(EMBEDDED_WEB_BUILD).length - 1
  if (found !== 1) {
    throw new Error(`Expected one build stamp placeholder in the Worker bundle, found ${found}`)
  }
  return bundle.replace(EMBEDDED_WEB_BUILD, encodeWebBuild(stamp))
}

if (import.meta.main) {
  const bundlePath = './dist/cloudflare/worker.js'
  let buildJson: string
  try {
    buildJson = await Deno.readTextFile('./apps/web/dist/build.json')
  } catch {
    console.warn('Worker bundle not stamped: run deno task build:web first')
    Deno.exit(0)
  }
  await Deno.writeTextFile(bundlePath, stampBundle(await Deno.readTextFile(bundlePath), buildJson))
  const stamp = webBuildStamp(JSON.parse(buildJson))!
  console.log(`Worker bundle stamped: ${stamp.sha}${stamp.release ? `, ${stamp.release}` : ''}`)
}
