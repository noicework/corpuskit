import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import {
  blankDraft,
  createdMessage,
  labelsetIdFrom,
  resultMessage,
  validate,
  validateNew,
} from './LabelsetsPanel.tsx'

const panelSource = await Deno.readTextFile(new URL('LabelsetsPanel.tsx', import.meta.url))
const taxonomySource = await Deno.readTextFile(new URL('../TaxonomyPage.tsx', import.meta.url))
const apiSource = await Deno.readTextFile(
  new URL('../../../../api/src/app.ts', import.meta.url),
)

describe('LabelsetsPanel - creating a set in place', () => {
  it('derives the id exactly the way the create route does', () => {
    expect(labelsetIdFrom('Marine Region')).toBe('marine-region')
    expect(labelsetIdFrom('  Post-harvest / Storage!  ')).toBe('post-harvest-storage')
    expect(labelsetIdFrom('***')).toBe('')
    // The route's derivation, verbatim, so the preview never drifts from the server.
    expect(apiSource).toContain(
      "parsed.data.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')",
    )
    expect(panelSource).toContain(
      "title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')",
    )
  })

  it('validates a new set the way the server will', () => {
    expect(validateNew(blankDraft(), [])).toEqual(['The set needs a name.', 'Label 1 has no name.'])
    const ok = {
      title: 'Region',
      multiple: false,
      labels: [{ title: 'North', text: 'Northern waters.' }],
    }
    expect(validateNew(ok, [])).toEqual([])
    expect(validateNew(ok, ['region'])).toEqual([
      'A set with the id "region" already exists - choose another name.',
    ])
    expect(validateNew({ ...ok, title: '!!!' }, [])).toEqual([
      'The name needs at least one letter or digit.',
    ])
    expect(validate({ ...ok, labels: [...ok.labels, { title: 'north', text: '' }] })).toEqual([
      'Label "north" appears more than once.',
    ])
    expect(validate({ ...ok, labels: [{ title: 'North', text: 'x'.repeat(601) }] })).toEqual([
      'The definition of "North" is longer than 600 characters.',
    ])
    expect(validate({ ...ok, labels: [] })).toEqual(['Add at least one label.'])
  })

  it('tells the administrator that creating restarts nothing, in one line', () => {
    expect(createdMessage('Region')).toBe(
      'Created "Region". No labeller was created or restarted.',
    )
  })

  it('reports a save with no carrying labeller plainly', () => {
    expect(resultMessage('Topic', { ok: true, id: 'topic', agents: [] })).toBe(
      'Saved "Topic". No labeller carries this set, so no agent was restarted.',
    )
  })

  it('no longer sends people to the Taxonomy page to create a set', () => {
    expect(panelSource).not.toContain('Taxonomy page')
    expect(panelSource).toContain('New label set')
  })
})

describe('TaxonomyPage - administrator rule', () => {
  it('uses the ManagePage credential rule: signed-in administrator or passcode', () => {
    expect(taxonomySource).toContain('const ssoAdmin = auth?.user?.isAdmin === true')
    expect(taxonomySource).toContain('const isAdmin = ssoAdmin || passcode.length > 0')
    expect(taxonomySource).toContain(
      "const adminCredential = ssoAdmin ? 'microsoft-sso' : passcode",
    )
    expect(taxonomySource).not.toContain(
      "const isAdmin = Boolean(sessionStorage.getItem('rp-admin-passcode'))",
    )
  })
})
