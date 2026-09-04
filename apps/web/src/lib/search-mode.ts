/**
 * Search page intent: an ANSWERED search returns results plus a streamed, cited
 * AI answer; a RESULTS ONLY search returns the result list alone and spends no
 * LLM call. Answered is the default - a cited answer over the matched sources is
 * what the portal is for - so the URL only carries `answer=0`, the deliberate
 * opt-out. Both states stay shareable and reload to exactly what the sender saw,
 * and the common case keeps a clean URL.
 */

/**
 * True when the URL wants a cited AI answer alongside the results, which is the
 * default. Only the exact opt-out value `answer=0` turns it off, so links minted
 * while the answer was opt-in (`?answer=1`) still resolve to an answered search.
 */
export function readAnswerMode(params: URLSearchParams): boolean {
  return params.get('answer') !== '0'
}

/**
 * The `answer` URL param value for a mode, shaped for the page's param-patching
 * helper: `null` clears the param back to the answered default so the URL stays
 * clean, `'0'` records the results-only opt-out so it survives a share or reload.
 */
export function answerModeParam(on: boolean): string | null {
  return on ? null : '0'
}
