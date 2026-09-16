/**
 * Which paths the portal answers as pages, and which ones are the internet
 * scanning for someone else's mistakes.
 *
 * The Worker and the development server both serve the single-page shell for
 * every path the web router owns. Every other path used to get the same shell
 * with a 200, which told each scanner that `/.env` and
 * `/wp-admin/install.php` deserved a closer look and answered `/robots.txt`
 * with HTML. The shell is still served for an unknown path, so a person sees
 * the app's own not-found page, but with the 404 the path deserves, and the
 * routine probes are refused before any asset lookup.
 */

const PROBE_PREFIXES = ['/wp-', '/wordpress', '/xmlrpc', '/phpmyadmin', '/cgi-bin/']
const PROBE_SUFFIX =
  /\.(?:php\d?|phtml|asp|aspx|jsp|jspx|cgi|sql|bak|old|orig|swp|zip|tar|tgz|gz|gzip|rar|7z)$/

/**
 * A path the web router renders, or a marketing document built beside it.
 * Everything under `/t/` belongs to the router, which has its own not-found
 * page and whose entity and help segments may legitimately contain dots.
 */
export function documentPath(pathname: string): boolean {
  if (pathname === '/' || pathname === '/home') return true
  if (pathname === '/admin' || pathname === '/admin/') return true
  if (pathname === '/about' || pathname === '/about/' || pathname === '/about.html') return true
  if (pathname === '/docs' || pathname.startsWith('/docs/')) return true
  return pathname.startsWith('/t/') && pathname.length > '/t/'.length
}

/**
 * A request for secrets, server-side scripts or archives this application
 * never serves: dotfiles outside `/.well-known/`, PHP and friends, database
 * dumps and backups, and the WordPress surface.
 */
export function probePath(pathname: string): boolean {
  let path = pathname
  try {
    path = decodeURIComponent(pathname)
  } catch {
    // Malformed encoding is left to the ordinary not-found answer.
  }
  const lower = path.toLowerCase()
  if (lower.startsWith('/.well-known/')) return false
  return /\/\.[^/]/.test(lower) || PROBE_SUFFIX.test(lower) ||
    PROBE_PREFIXES.some((prefix) => lower.startsWith(prefix))
}
