import { expect } from '@std/expect'
import { documentPath, probePath } from './public-paths.ts'

Deno.test('documentPath covers every path the router or the marketing build renders', () => {
  const rendered = [
    '/',
    '/home',
    '/admin',
    '/admin/',
    '/about',
    '/about/',
    '/about.html',
    '/docs',
    '/docs/',
    '/docs/getting-started',
    '/t/marine',
    '/t/marine/',
    '/t/marine/library/abc',
    '/t/marine/entity/.NET',
    '/t/marine/robots.txt',
  ]
  for (const path of rendered) expect([path, documentPath(path)]).toEqual([path, true])

  const unknown = [
    '/t',
    '/t/',
    '/admin/users',
    '/robots.txt',
    '/sitemap.xml',
    '/nope',
    '/app.js',
    '/.env',
    '/firebase-adminsdk.json',
  ]
  for (const path of unknown) expect([path, documentPath(path)]).toEqual([path, false])
})

Deno.test('probePath refuses secret, script and archive probes', () => {
  const probes = [
    '/.env',
    '/.env.yaml',
    '/transactional/.env',
    '/.git/config',
    '/.aws/credentials',
    '/.DS_Store',
    '/wp-admin/install.php',
    '/wp-login.php',
    '/wordpress/wp-includes/x',
    '/xmlrpc.php',
    '/phpinfo.php',
    '/old/phpinfo.PHP',
    '/_phpinfo.php5',
    '/phpmyadmin/index.php',
    '/cgi-bin/test',
    '/auth%20(1).zip',
    '/auth/auth%20%283%29.gzip',
    '/backup.sql',
    '/site.tar.gz',
    '/config.bak',
    '/index.php',
  ]
  for (const path of probes) expect([path, probePath(path)]).toEqual([path, true])
})

Deno.test('probePath leaves real assets, documents and well-known paths alone', () => {
  const legitimate = [
    '/',
    '/app.js',
    '/styles.css',
    '/favicon.png',
    '/apple-touch-icon.png',
    '/og/card.png',
    '/robots.txt',
    '/about',
    '/docs/getting-started',
    '/t/marine/library',
    '/.well-known/security.txt',
    '/%E2%82',
  ]
  for (const path of legitimate) expect([path, probePath(path)]).toEqual([path, false])
})
