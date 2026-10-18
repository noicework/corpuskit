import { Buffer } from 'node:buffer'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { BrandingAsset, BrandingAssetStore, BrandingKind, LayoutImageKind } from './app.ts'
import { ownedMutation, type OwnedMutationBoundary } from './stores.ts'

const types: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
  otf: 'font/otf',
}
const fixed = ['logo', 'logo-dark', 'hero', 'font-heading', 'font-body'] as const

/** File-backed branding with the same audited store boundary as the other local stores. */
export class FileBrandingStore implements BrandingAssetStore {
  constructor(private readonly root: string, private readonly boundary?: OwnedMutationBoundary) {}

  private path(slug: string, kind: BrandingKind): string {
    if (
      !/^[a-zA-Z0-9_-]{1,64}$/.test(slug) ||
      (!fixed.includes(kind as typeof fixed[number]) &&
        !/^image-[a-z0-9][a-z0-9-]{0,39}$/.test(kind))
    ) {
      throw new Error('Invalid branding storage identifier')
    }
    return join(this.root, 'assets', slug, `${kind}.json`)
  }

  private legacy(slug: string, kind: BrandingKind): string[] {
    this.path(slug, kind)
    const image = kind.startsWith('image-')
    const extensions = image
      ? ['png', 'jpg', 'webp']
      : kind.startsWith('font-')
      ? ['woff2', 'woff', 'ttf', 'otf']
      : ['png', 'jpg', 'jpeg', 'webp', 'svg']
    return extensions.map((ext) =>
      image
        ? join(this.root, 'images', slug, `${kind.slice(6)}.${ext}`)
        : join(this.root, `${slug}-${kind}.${ext}`)
    )
  }

  get(slug: string, kind: BrandingKind): BrandingAsset | null {
    try {
      const stored = JSON.parse(readFileSync(this.path(slug, kind), 'utf8'))
      return { ...stored, bytes: Uint8Array.from(Buffer.from(stored.bytes, 'base64')) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    for (const path of this.legacy(slug, kind)) {
      try {
        return {
          bytes: Uint8Array.from(readFileSync(path)),
          contentType: types[path.slice(path.lastIndexOf('.') + 1)]!,
          version: String(Math.round(statSync(path).mtimeMs)),
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return null
  }

  put(slug: string, kind: BrandingKind, asset: BrandingAsset): void {
    ownedMutation([
      ...this.legacy(slug, kind).map((path) => ({ path, value: undefined })),
      {
        path: this.path(slug, kind),
        value: { ...asset, bytes: Buffer.from(asset.bytes).toString('base64') },
      },
    ], this.boundary)
  }

  remove(slug: string, kind: LayoutImageKind): boolean {
    const found = this.get(slug, kind) !== null
    ownedMutation(
      [
        this.path(slug, kind),
        ...this.legacy(slug, kind),
      ].map((path) => ({ path, value: undefined })),
      this.boundary,
    )
    return found
  }

  images(slug: string): { name: string; version: string }[] {
    this.path(slug, 'logo')
    const names = new Set<string>()
    for (
      const [dir, pattern] of [
        [join(this.root, 'assets', slug), /^image-([a-z0-9][a-z0-9-]{0,39})\.json$/],
        [join(this.root, 'images', slug), /^([a-z0-9][a-z0-9-]{0,39})\.(?:png|jpg|webp)$/],
      ] as const
    ) {
      try {
        for (const entry of readdirSync(dir)) {
          const match = pattern.exec(entry)
          if (match) names.add(match[1]!)
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return [...names].sort().map((name) => ({
      name,
      version: this.get(slug, `image-${name}`)!.version,
    }))
  }

  erase(slug: string): number {
    this.path(slug, 'logo')
    // Erasure must also remove malformed records without trying to decode their bytes/version.
    const paths = fixed.flatMap((kind) => this.legacy(slug, kind))
    for (const dir of [join(this.root, 'assets', slug), join(this.root, 'images', slug)]) {
      try {
        paths.push(
          ...readdirSync(dir, { withFileTypes: true })
            .filter((entry) => entry.isFile()).map((entry) => join(dir, entry.name)),
        )
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    const present = paths.filter((path) => {
      try {
        return statSync(path).isFile()
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw error
      }
    })
    ownedMutation(present.map((path) => ({ path, value: undefined })))
    return present.length
  }
}
