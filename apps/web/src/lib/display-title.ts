/**
 * Display-time copy fixes for text the portal did not author: curated titles
 * that arrived in capitals ("A WORLDWIDE ENIGMA STUDY ON ...") and generated
 * summaries that use em dashes. Pure and unit-tested; applied at render.
 */

/** Words kept lowercase inside a title-cased headline (never as the first word). */
const SMALL_WORDS = new Set([
  'a',
  'an',
  'and',
  'as',
  'at',
  'but',
  'by',
  'for',
  'from',
  'in',
  'into',
  'nor',
  'of',
  'on',
  'or',
  'per',
  'the',
  'to',
  'via',
  'vs',
  'with',
  'without',
])

/**
 * Tokens that stay in capitals even when the rest of the title is re-cased:
 * anything with a digit (SCN1A, COVID-19), and the domain's common initialisms.
 */
const KEEP_CAPS = new Set([
  'ADHD',
  'AED',
  'AEDS',
  'ASM',
  'ASMS',
  'CBD',
  'CNS',
  'CSF',
  'CT',
  'DBS',
  'DNA',
  'ECG',
  'EEG',
  'EMG',
  'ENIGMA',
  'EU',
  'FDA',
  'FMRI',
  'GABA',
  'GABAA',
  'HIV',
  'ICU',
  'ILAE',
  'IQ',
  'MEG',
  'MRI',
  'NMDA',
  'NMDAR',
  'PET',
  'RCT',
  'RNA',
  'SEEG',
  'SUDEP',
  'UK',
  'US',
  'USA',
  'VNS',
  'WHO',
])

/** A word that is entirely capitals (letters only, at least two of them). */
function isAllCaps(word: string): boolean {
  const letters = word.replace(/[^A-Za-z]/g, '')
  return letters.length >= 2 && letters === letters.toUpperCase()
}

function recaseWord(word: string, first: boolean): string {
  const core = word.replace(/[^A-Za-z0-9]/g, '')
  if (/\d/.test(core) || KEEP_CAPS.has(core.toUpperCase())) return word
  const lower = word.toLowerCase()
  if (!first && SMALL_WORDS.has(core.toLowerCase())) return lower
  // Hyphenated compounds re-case each part ("DRUG-RESISTANT" -> "Drug-Resistant").
  return lower.replace(/(^|[-/(])([a-z])/g, (_m, sep: string, ch: string) => sep + ch.toUpperCase())
}

/**
 * Re-case a title that arrived in capitals. A title is treated as shouted
 * when most of its alphabetic words are all-caps; a leading section label
 * ("GENETICS. The Human Variome Project") is re-cased on its own. Ordinary
 * mixed-case titles pass through untouched, initialisms included.
 */
export function presentTitle(title: string): string {
  const trimmed = title.trim()
  if (!trimmed) return title
  const words = trimmed.split(/\s+/)
  const alphabetic = words.filter((w) => /[A-Za-z]{2,}/.test(w))
  if (alphabetic.length === 0) return trimmed
  const shouted = alphabetic.filter(isAllCaps).length / alphabetic.length
  if (shouted >= 0.7) {
    // A word after a colon or full stop opens a subtitle, so it is capitalised
    // like a first word even when it is a small one.
    return words
      .map((w, i) => recaseWord(w, i === 0 || /[:.?!]$/.test(words[i - 1] ?? '')))
      .join(' ')
  }
  // "GENETICS. The Human Variome Project" - a capitalised section label in
  // front of a normal title.
  const label = trimmed.match(/^([A-Z][A-Z]+)([.:])\s+(?=\S)/)
  if (label && !KEEP_CAPS.has(label[1]!)) {
    return recaseWord(label[1]!, true) + label[2]! + ' ' + trimmed.slice(label[0].length)
  }
  return trimmed
}

/** Em and en dashes used as punctuation become a spaced hyphen (house style). */
export function plainDashes(text: string): string {
  return text
    .replace(/\s*[—―]\s*/g, ' - ')
    // An en dash between words is punctuation; between digits it is a range and stays.
    .replace(/(?<!\d)\s*–\s*(?!\d)/g, ' - ')
}
