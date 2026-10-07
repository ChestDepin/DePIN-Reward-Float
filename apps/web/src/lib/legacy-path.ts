const APP_DIR = 'app/'

// The terminal used to be the site root; now the landing is, and the terminal sits
// under app/. Pages answers every path it has no file for with the root 404.html,
// which is this app's shell — so a link shared before the move arrives here and is
// moved under app/ instead of starting a router whose basename it does not match.
export function legacyAppPath(pathname: string, base: string): string | null {
  if (!base.endsWith(`/${APP_DIR}`)) return null
  const site = base.slice(0, -APP_DIR.length)
  if (!pathname.startsWith(site)) return null
  if (pathname.startsWith(base) || pathname === base.slice(0, -1)) return null
  return base + pathname.slice(site.length)
}
