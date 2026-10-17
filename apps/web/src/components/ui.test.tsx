import { expect } from '@std/expect'
import { renderToStaticMarkup } from 'react-dom/server'
import { ArrowRight, Plus, Search } from './icons.tsx'
import {
  Button,
  type ButtonSize,
  type ButtonVariant,
  ErrorCard,
  IconButton,
  SectionHeader,
} from './ui.tsx'

Deno.test('Button maps every variant and size to the shared class contract', () => {
  const variants: ButtonVariant[] = ['primary', 'outline', 'ghost', 'danger', 'danger-outline']
  const sizes: ButtonSize[] = ['sm', 'md', 'lg']
  for (const variant of variants) {
    for (const size of sizes) {
      const html = renderToStaticMarkup(<Button variant={variant} size={size}>Save</Button>)
      expect(html).toContain(`rp-btn rp-btn-${variant}`)
      if (size === 'md') expect(html).not.toContain('rp-btn-md')
      else expect(html).toContain(`rp-btn-${size}`)
      expect(html).toContain('type="button"')
      expect(html).toContain('>Save</button>')
    }
  }
})

Deno.test('Button keeps native form attributes and places decorative icons around its label', () => {
  for (const size of ['sm', 'md', 'lg'] as const) {
    const html = renderToStaticMarkup(
      <Button
        type='submit'
        form='document-form'
        name='intent'
        value='save'
        disabled
        aria-busy='true'
        className='custom-action'
        size={size}
        leadingIcon={Plus}
        trailingIcon={ArrowRight}
      >
        Save document
      </Button>,
    )
    for (
      const attribute of [
        'type="submit"',
        'form="document-form"',
        'name="intent"',
        'value="save"',
        'disabled=""',
        'aria-busy="true"',
        'custom-action',
      ]
    ) expect(html).toContain(attribute)
    expect(html.match(/<svg /g)?.length).toBe(2)
    expect(html.match(/aria-hidden="true"/g)?.length).toBe(2)
    expect(html).toMatch(/<\/svg>Save document<svg /)
    const dimension = size === 'lg' ? '1.25rem' : '1rem'
    expect(html.match(new RegExp(`width="${dimension}"`, 'g'))?.length).toBe(2)
  }
})

Deno.test('IconButton requires a non-empty accessible name and matches its title', () => {
  const label = '検索'
  const html = renderToStaticMarkup(
    <IconButton
      label={label}
      icon={Search}
      aria-pressed='true'
      disabled
      className='search-action'
    />,
  )
  expect(html).toContain(`aria-label="${label}"`)
  expect(html).toContain(`title="${label}"`)
  expect(html).toContain('rp-btn rp-btn-ghost rp-icon-btn search-action')
  expect(html).toContain('aria-pressed="true"')
  expect(html).toContain('disabled=""')
  expect(html).toContain('aria-hidden="true"')
  expect(html).not.toContain('<title>')
  for (const blank of ['', '  ', '\n\t']) {
    expect(() => renderToStaticMarkup(<IconButton label={blank} icon={Search} />))
      .toThrow('IconButton requires a non-empty label')
  }
})

Deno.test('IconButton follows button sizes and accepts an explicit variant', () => {
  for (const size of ['sm', 'md', 'lg'] as const) {
    const html = renderToStaticMarkup(
      <IconButton label='Search' icon={Search} variant='outline' size={size} />,
    )
    expect(html).toContain('rp-btn-outline')
    expect(html).toContain('rp-icon-btn')
    expect(html).toContain(`width="${size === 'lg' ? '1.25rem' : '1rem'}"`)
  }
})

Deno.test('SectionHeader renders each requested heading level and its optional slots', () => {
  for (const headingLevel of [1, 2, 3, 4, 5, 6] as const) {
    const html = renderToStaticMarkup(
      <SectionHeader
        id='recent-additions'
        className='custom-section'
        title='Recent additions'
        headingLevel={headingLevel}
        description='Documents added to the Library.'
        actions={<Button size='sm' variant='ghost'>Refresh</Button>}
      />,
    )
    expect(html).toContain('id="recent-additions"')
    expect(html).toContain('custom-section')
    expect(html).toContain(`<h${headingLevel} class="rp-section-title text-base font-semibold">`)
    expect(html).toContain(`Recent additions</h${headingLevel}>`)
    expect(html).toContain('rp-section-head-text')
    expect(html).toContain('rp-section-desc')
    expect(html).toContain('Documents added to the Library.')
    expect(html).toContain('rp-section-head-actions')
    expect(html).toContain('>Refresh</button>')
  }
  const html = renderToStaticMarkup(<SectionHeader title='Recent additions' />)
  expect(html).toContain('<h2 ')
  expect(html).not.toContain('rp-section-desc')
  expect(html).not.toContain('rp-section-head-actions')
})

Deno.test('ErrorCard keeps its retry copy while using shared stroke icons', () => {
  const html = renderToStaticMarkup(<ErrorCard message='Unavailable' onRetry={() => {}} />)
  expect(html).toContain('Something went wrong')
  expect(html).toContain('Try again</button>')
  expect(html).toContain('rp-btn-outline')
  expect(html.match(/viewBox="0 0 24 24"/g)?.length).toBe(2)
  expect(html.match(/stroke-width="1.75"/g)?.length).toBe(2)
  expect(html).not.toContain('viewBox="0 0 20 20"')
})
