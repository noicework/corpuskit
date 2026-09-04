FROM denoland/deno:2.9.5

WORKDIR /app

# Pinned build tooling for the web bundle. Versions must match the CI gate
# (.github/workflows/deploy.yml) and local dev tooling (brew) - bump all
# three together. Fly's remote builder is linux/amd64, so these fetch the
# linux-x64 binaries directly rather than relying on `npm`/`npx` (neither is
# available in this image, and none of these calls go through the npm CLI).
ARG ESBUILD_VERSION=0.28.2
ARG TAILWINDCSS_VERSION=4.3.3

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# esbuild: the npm registry tarball is the canonical source; unpkg mirrors the
# same content and stays as a fallback (either host can be flaky or blocked
# from a given network - unpkg 500'd from Fly's builder on 2026-08-28).
RUN { curl -fsSL --retry 3 --retry-all-errors -o /tmp/esbuild.tgz \
      "https://registry.npmjs.org/@esbuild/linux-x64/-/linux-x64-${ESBUILD_VERSION}.tgz" \
    && tar -xzf /tmp/esbuild.tgz -C /tmp \
    && mv /tmp/package/bin/esbuild /usr/local/bin/esbuild \
    && rm -rf /tmp/esbuild.tgz /tmp/package ; } \
  || curl -fsSL --retry 3 --retry-all-errors -o /usr/local/bin/esbuild \
    "https://unpkg.com/@esbuild/linux-x64@${ESBUILD_VERSION}/bin/esbuild"
RUN chmod +x /usr/local/bin/esbuild \
  && curl -fsSL --retry 3 --retry-all-errors -o /usr/local/bin/tailwindcss \
    "https://github.com/tailwindlabs/tailwindcss/releases/download/v${TAILWINDCSS_VERSION}/tailwindcss-linux-x64" \
  && chmod +x /usr/local/bin/tailwindcss

COPY deno.json ./
COPY packages ./packages
COPY apps ./apps

RUN deno cache apps/api/src/server.ts

# Build the SPA into apps/web/dist so server.ts (`./apps/web/dist`) has
# something to serve - this is the fix for the site 404ing in production.
RUN deno task build:web

EXPOSE 8787

CMD ["run", "--allow-net", "--allow-env", "--allow-read", "--allow-write=/app/data", "apps/api/src/server.ts"]
