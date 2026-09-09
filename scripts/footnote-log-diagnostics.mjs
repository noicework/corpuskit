// Read-only, time-bounded incident probe. Never print raw events or credentials.
const account = process.env.CLOUDFLARE_ACCOUNT_ID
const token = process.env.CLOUDFLARE_API_TOKEN
if (!account || !token) throw new Error('Cloudflare diagnostic credentials unavailable')
const response = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${account}/workers/observability/telemetry/query`,
  {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      queryId: 'corpuskit-footnote-incident-20260909',
      timeframe: {
        from: Date.parse('2026-09-09T00:51:00Z'),
        to: Date.parse('2026-09-09T00:57:00Z'),
      },
      dry: true,
      view: 'events',
      limit: 100,
      parameters: {
        filters: [{
          key: '$metadata.service',
          type: 'string',
          operation: 'eq',
          value: 'corpuskit',
        }],
        needle: { value: 'footnote' },
      },
    }),
  },
)
console.log(JSON.stringify({ status: response.status }))
const payload = await response.json()
if (!response.ok || payload.success === false) {
  console.log(JSON.stringify({ errorCodes: payload.errors?.map((e) => e.code) }))
  process.exitCode = 1
} else {
  const raw = JSON.stringify(payload.result)
  const classifications = [
    'FootnoteError',
    'arag_footnote_validation_failed',
    'missing_definition',
    'missing_mapping',
    'invalid_mapping',
    'conflicting_mapping',
    'invalid_definition',
    'conflicting_definition',
    'unsupported_context',
    'anonymous_context',
    'metadata_context',
    'generated_context',
    'out_of_scope',
    'stream_rewrite',
    'unexpected_standard_citations',
    'The response citation links could not be verified',
    'The answer service had a problem',
    'citation',
    'footnote',
    'USER_CONTEXT',
    'Illegal invocation',
    'TypeError',
    'ReferenceError',
    'SyntaxError',
    'AragApiError',
    'timed out',
  ]
  console.log(JSON.stringify({
    resultKeys: Object.keys(payload.result ?? {}),
    matches: Object.fromEntries(classifications.map((s) => [s, raw.split(s).length - 1])),
  }))
}
