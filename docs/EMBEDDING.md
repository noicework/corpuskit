# Embed a portal's research assistant

A portal administrator opens **Manage > Behaviour > Embed the research assistant**, enables
embedding, and lists the website origins allowed to display it, one per line. Use exact HTTPS
origins such as `https://research.example` or `https://research.example:8443`. Paths, wildcards,
credentials, HTTP addresses and more than 20 origins are refused. An empty list permits no frames.
The browser checks every ancestor, so list every origin when another frame contains your website.

Paste the supplied snippet where the assistant should appear:

```html
<script src="https://portal.example/t/soil-hub/embed.js"
  data-mode="inline" data-view="own" data-height="640" defer></script>
```

Replace the hostname and slug with the hosted portal's URL. Use `data-mode="button"` for a
button opening a modal dialog instead of an inline frame. The dialog moves focus into the assistant,
traps keyboard focus, closes with Escape or its close button, and restores focus to its launcher.
Both modes fit their containing width. Height is in pixels, bounded to 240-2000, default 640;
a dialog also fits the viewport. No animation is required. Include the script once per widget.
The host site's content security policy must allow this script and the portal's frame origin.

`data-view="own"` searches only the portal's collection and hides the partner switch.
`data-view="federated"` offers **Search partner collections too**, initially on, when the portal
has `agentAsk` enabled. Visitors can turn it off to search only the portal's own collection.
Omitting `data-view` uses the administrator's default view. Federation uses the existing
`POST /api/t/:slug/ask-agent` route and its configured partners, permission checks and limits;
own collection search uses `POST /api/t/:slug/ask`. The widget does not configure partners.
Add `data-lang="ja"` for Japanese interface strings, or `en` for English. Otherwise it follows the
host document's Japanese language or the portal's language preference and default.

A plain iframe is also supported:

```html
<iframe src="https://portal.example/t/soil-hub/embed?view=own"
  title="Soil research assistant" width="100%" height="640"></iframe>
```

The chrome-less page carries the portal's name, organisation and appearance, cited answers and
links opening the full portal in a new tab. It shares Ask's answer renderer. The smaller federated
renderer shares Ask's markdown renderer and displays source labels, passages and permitted links;
it does not include the agent page's planning UI. "Powered by CorpusKit" appears by default;
an explicitly configured portal footer follows its `poweredBy` choice.
Citation markers sit inline with the answer and move keyboard focus to their source card.
Source links open the full portal or partner document in a new tab. Organisation and product
names come from the portal's branding, including any configured translations, rather than
the interface catalogue.

## Access and framing

Embedding is off until enabled. Only the exact `/t/:slug/embed` shell receives
`Content-Security-Policy: frame-ancestors <allowed origins>`. Other pages retain their existing
framing policy. The loader `/t/:slug/embed.js` is public script, not a research API or credential.
The shell and loader are served with `private, no-store` and `noindex, nofollow`, so settings
changes apply on their next request. Disabling embedding refuses both with 404. Already open
frames reload to pick up a framing change. Allowed origins control framing, not access to a public
portal's API; the existing portal access mode controls research access.

Private portals still require a signed-in session with the portal's existing permissions. The frame
shows safe branding and explains the requirement, with **Open full portal** opening a new tab.
Sign in and use the full portal there. Session cookies remain `Secure; HttpOnly; SameSite=Lax`:
a cross-site frame does not receive them, even after sign-in in another tab. Public portals also
work when the browser blocks persistent third-party storage: a client id stays in memory for that
document, without storing credentials or answer history. Same-site frames may
receive an existing session, subject to browser policy. No cookie policy is weakened and no token is
passed in a URL or between windows. Organisation sign-in is never attempted within a third-party frame.

## Storage and operations

`embedding: { enabled, allowedOrigins, defaultView }` is tenant configuration saved through
`PATCH /api/admin/tenants/:slug`, guarded by `behaviour.write`, audited as
`tenant.behaviour.update`, and refused during hosting read-only mode. It uses the existing
Durable Object tenant adapter and local DATA_DIR tenant adapter. Erasing tenant configuration erases
these settings; no new erased record kind or browser answer history is introduced. Ask requests
continue to use the existing answer evidence retention, rate limits, hosting limits and audit rules.
