// ---------------------------------------------------------------------------
// Design-review fixture: a deterministic, offline marine research corpus for
// the screenshot harness (e2e/design-shots.ts). Everything here is fictional -
// the institute is the `marine` seed's own fictional organisation, and every
// author, project, figure and finding is invented for the review. Nothing
// calls a real service: retrieval, answers, the knowledge graph and every
// Manage tab read from the in-memory records below.
//
// `DesignProvider` replaces the reader-facing retrieval provider and
// `designManagement()` the management surface. Both are imported only by the
// harness, never by product code or the e2e test suite.
// ---------------------------------------------------------------------------
import type {
  AskEvent,
  CatalogItem,
  CatalogPage,
  Citation,
  FacetCounts,
  KbAgent,
  Labelset,
  Question,
  RecentResource,
  ResourceContent,
  ResourceSummary,
  ScoredResource,
  SearchResults,
  TenantConfig,
} from '@research-portal/core'
import type {
  AskOptions,
  CatalogOptions,
  SearchOptions,
} from '../../packages/retrieval/src/provider.ts'
import type { BuildAppOptions } from '../../apps/api/src/app.ts'
import { DoubleProvider } from './double-provider.ts'

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

/** One fictional resource: its catalogue record, its body text and the questions it answers. */
export interface DesignResource {
  summary: ResourceSummary
  /** The resource's extracted text as markdown: headings, paragraphs, lists and tables. */
  body: string
  /** Questions the body answers, each with the verbatim sentence that answers it. */
  questions: { question: string; evidence: string }[]
}

const origin = (slug: string) => `https://example.org/southern-waters/${slug}`

function resource(
  summary: Omit<ResourceSummary, 'keyFacts' | 'enriched' | 'originUrl'> & {
    keyTakeaways: string[]
  },
  body: string,
  questions: DesignResource['questions'],
): DesignResource {
  return {
    summary: {
      ...summary,
      keyFacts: summary.keyTakeaways.slice(0, 2),
      enriched: true,
      originUrl: origin(summary.id),
    },
    body: body.trim(),
    questions,
  }
}

/** The answer route's question: the seed's own suggested question about heatwaves. */
export const DESIGN_QUESTION =
  'How are marine heatwaves affecting abalone populations along the southern coast?'

/** The entity the entity route opens: a well-connected node of the fixture graph. */
export const DESIGN_ENTITY = 'Greenlip abalone'

const HEATWAVE_FINDING =
  'Across 46 monitored reef sites, juvenile density fell by 38% between 2019 and 2024 at sites ' +
  'where water temperature stayed above the 90th percentile for more than 21 days.'
const OUTLOOK_FINDING =
  'Marine heatwave days on the southern shelf are expected to double by 2035 under a moderate ' +
  'emissions pathway, from an average of 18 days a year to around 36 days.'
const KELP_FINDING =
  'Restoration trials at Tern Island restored kelp canopy on 5 of 12 cleared plots within two ' +
  'years of purple sea urchin removal, and abalone returned to those plots within the same period.'
const HEATWAVE_LEAD =
  'Marine heatwaves are now the main reason greenlip abalone recruitment is failing on parts of ' +
  'the southern coast.'
const HEATWAVE_LAG =
  'Adult abalone mostly survived, so the losses show up later as smaller year classes rather ' +
  'than as an immediate fall in catch.'
const OUTLOOK_LEAD = 'Warming on the southern shelf is expected to make heatwaves more common.'
const OUTLOOK_RISK =
  'Recruitment failures like those on the Western Gulf reefs are therefore likely to recur more ' +
  'often.'
const KELP_LEAD = 'Kelp canopy decides how quickly abalone reefs recover after a heatwave.'
const KELP_ADVICE =
  'Protecting and restoring canopy is the most practical way to help abalone through hotter ' +
  'summers.'

export const DESIGN_RESOURCES: DesignResource[] = [
  resource(
    {
      id: 'sw-abalone-heatwaves',
      title: 'Marine heatwaves and greenlip abalone recruitment on the southern coast',
      summary:
        'A six-year survey of 46 reef sites linking prolonged marine heatwaves to sharp falls in ' +
        'greenlip abalone recruitment, with the heaviest losses on the western gulf reefs and ' +
        'practical options for adjusting harvest settings after a heatwave year.',
      type: 'document',
      kind: 'final-report',
      topicIds: ['marine-sustainability', 'stock-assessment'],
      published: '2024-11-18',
      year: '2024',
      authors: ['Mara Lindqvist', 'Tomas Okafor', 'Priya Ramanathan'],
      sourceName: 'SWRI-2019-041 final report.pdf',
      keyTakeaways: [
        'Juvenile density fell by 38% at reef sites that stayed above the 90th percentile water ' +
        'temperature for more than 21 days.',
        'Western Gulf reefs recorded 64 heatwave days between 2019 and 2024, the most of any reef ' +
        'group surveyed.',
        'Recruitment recovered within two seasons where giant kelp canopy stayed intact.',
        'Size-limit changes should wait until juvenile surveys are repeated after a heatwave year.',
      ],
      quotesOfInterest: [
        'Heat stress did not kill adult abalone in large numbers; it quietly removed the next ' +
        'generation.',
        'Reefs that kept their kelp canopy bounced back within two seasons.',
      ],
      keywords: ['greenlip abalone', 'marine heatwave', 'recruitment', 'reef monitoring'],
    },
    `
## Summary

The Reef Recruitment Monitoring Program surveyed greenlip abalone on 46 reef sites along the southern coast every autumn from 2019 to 2024. ${HEATWAVE_LEAD} ${HEATWAVE_FINDING} ${HEATWAVE_LAG}

## Methods

Pairs of divers counted juvenile abalone (under 40 mm shell length) along fixed 50 metre transects at each site, while temperature loggers recorded water temperature every 30 minutes at 8 metres depth. A heatwave day was any day above the local 90th percentile for that calendar day, measured against a 1990 to 2018 baseline.

## Results

Heatwave exposure varied widely between reef groups, and the fall in juvenile density tracked that exposure closely.

| Reef group | Heatwave days (2019-2024) | Change in juvenile density |
| --- | --- | --- |
| Western Gulf reefs | 64 | -52% |
| Cape Wren | 31 | -24% |
| Tern Island | 12 | -6% |

On the Western Gulf reefs, 64 heatwave days were recorded between 2019 and 2024 and juvenile density fell by 52%. At Cape Wren, 31 heatwave days were recorded and juvenile density fell by 24%. Tern Island recorded 12 heatwave days and juvenile density fell by 6%.

## Kelp canopy and recovery

Recruitment recovered within two seasons where giant kelp canopy stayed intact, because the canopy shades the reef and holds the drift algae juveniles feed on. Where purple sea urchin barrens had replaced the kelp, juvenile counts stayed low for the rest of the survey.

## Recommendations

- Repeat juvenile surveys in the autumn after any season with more than 21 heatwave days.
- Hold size-limit and quota changes until the repeat survey is in.
- Prioritise kelp protection on reefs that still carry a canopy.
`,
    [
      {
        question: 'How much did juvenile abalone density fall at the hottest reef sites?',
        evidence: HEATWAVE_FINDING,
      },
      {
        question: 'Which reef group recorded the most heatwave days?',
        evidence:
          'On the Western Gulf reefs, 64 heatwave days were recorded between 2019 and 2024 and ' +
          'juvenile density fell by 52%.',
      },
      {
        question: 'Why did some reefs recover faster than others?',
        evidence:
          'Recruitment recovered within two seasons where giant kelp canopy stayed intact, because ' +
          'the canopy shades the reef and holds the drift algae juveniles feed on.',
      },
      {
        question: 'What does the report recommend after a heatwave year?',
        evidence:
          'Repeat juvenile surveys in the autumn after any season with more than 21 heatwave days.',
      },
    ],
  ),
  resource(
    {
      id: 'sw-warming-outlook-2026',
      title: 'Southern ocean warming outlook for fisheries, 2026 to 2035',
      summary:
        'A plain-language outlook on how regional ocean warming is expected to change marine ' +
        'heatwave frequency, species ranges and fishing seasons across the southern shelf over ' +
        'the next decade.',
      type: 'web',
      kind: 'web-page',
      topicIds: ['marine-sustainability', 'fisheries-policy'],
      published: '2026-02-20',
      year: '2026',
      authors: ['Isla Fenwick', 'Samuel Ngata'],
      keyTakeaways: [
        'Marine heatwave days on the southern shelf are expected to double by 2035.',
        'Warm-water species are moving south by about 30 km each decade.',
        'Fishing seasons for temperate species may need to start earlier in spring.',
      ],
      quotesOfInterest: ['A heatwave year is no longer an outlier; it is a planning scenario.'],
    },
    `
## Outlook

This 2026 outlook draws on regional ocean models and twenty years of shelf temperature records. ${OUTLOOK_LEAD} ${OUTLOOK_FINDING} ${OUTLOOK_RISK}

## What changes for fisheries

Warm-water species are moving south by about 30 km each decade, and temperate species such as greenlip abalone and southern rock lobster are losing habitat at the warm edge of their range. Fishing seasons for temperate species may need to start earlier in spring to avoid the hottest months.

## Planning advice

Managers should treat a heatwave year as a planning scenario rather than an outlier, with agreed triggers for extra surveys and for pausing quota increases.
`,
    [
      {
        question: 'How often will marine heatwaves occur on the southern shelf by 2035?',
        evidence: OUTLOOK_FINDING,
      },
      {
        question: 'How fast are warm-water species moving south?',
        evidence: 'Warm-water species are moving south by about 30 km each decade',
      },
    ],
  ),
  resource(
    {
      id: 'sw-kelp-restoration',
      title: 'Restoring giant kelp forests after purple sea urchin barrens',
      summary:
        'Field trials at Tern Island testing urchin removal and kelp transplanting to rebuild ' +
        'canopy on barren reefs, with early evidence that abalone and reef fish return as the ' +
        'canopy recovers.',
      type: 'document',
      kind: 'report',
      topicIds: ['marine-sustainability'],
      published: '2026-04-14',
      year: '2026',
      authors: ['Priya Ramanathan', 'Tomas Okafor'],
      keyTakeaways: [
        'Urchin removal restored kelp canopy on 5 of 12 cleared plots within two years.',
        'Transplanting alone failed where urchin density stayed above 4 per square metre.',
        'Abalone returned to cleared plots within the same two years.',
      ],
      quotesOfInterest: ['The canopy came back first; everything else followed it.'],
    },
    `
## Trial design

Twelve barren plots at Tern Island were cleared of purple sea urchins by hand, six were cleared and planted with giant kelp, and six were left as controls.

## Results

${KELP_LEAD} ${KELP_FINDING} ${KELP_ADVICE} Transplanting alone failed where urchin density stayed above 4 per square metre, because urchins grazed the new plants within weeks.

## Next steps

The trial will expand to the Western Gulf reefs in 2027, where heatwave exposure has been highest.
`,
    [
      {
        question: 'How many cleared plots regained their kelp canopy?',
        evidence: KELP_FINDING,
      },
      {
        question: 'Why did transplanting kelp fail on some plots?',
        evidence:
          'Transplanting alone failed where urchin density stayed above 4 per square metre, ' +
          'because urchins grazed the new plants within weeks.',
      },
    ],
  ),
  resource(
    {
      id: 'sw-data-limited-harvest',
      title: 'Harvest strategies for data-limited fisheries: a practical guide',
      summary:
        'A guide for managers of small fisheries with short or patchy catch records, comparing ' +
        'catch-only, length-based and indicator methods and setting out decision rules that ' +
        'stay precautionary when data are thin.',
      type: 'document',
      kind: 'report',
      topicIds: ['stock-assessment', 'fisheries-policy'],
      published: '2022-03-09',
      year: '2022',
      authors: ['Helen Achterberg', 'Samuel Ngata'],
      keyTakeaways: [
        'Length-based methods performed best when at least 300 fish were measured each year.',
        'Catch-only methods overstated stock size in 3 of 5 test fisheries.',
        'A simple indicator rule with a 20% buffer kept every test stock above its limit.',
      ],
      quotesOfInterest: ['A modest rule applied every year beats a perfect model applied once.'],
    },
    `
## Why data-limited methods matter

Most of the 40 fisheries the institute advises have fewer than ten years of reliable catch data, so full stock assessments are rarely possible.

## Comparing methods

Length-based methods performed best when at least 300 fish were measured each year. Catch-only methods overstated stock size in 3 of 5 test fisheries, mostly where effort had changed over time.

## Recommended decision rule

A simple indicator rule with a 20% buffer kept every test stock above its limit reference point across 50 simulated years.
`,
    [
      {
        question: 'How many fish need to be measured for length-based methods to work well?',
        evidence:
          'Length-based methods performed best when at least 300 fish were measured each year.',
      },
    ],
  ),
  resource(
    {
      id: 'sw-white-spot-prawn',
      title: 'White spot syndrome virus surveillance in farmed black tiger prawns',
      summary:
        'Three years of pond surveillance on four prawn farms, showing how pooled sampling and ' +
        'faster laboratory testing shortened the time from first detection to pond ' +
        'quarantine.',
      type: 'document',
      kind: 'journal-article',
      topicIds: ['aquaculture-biosecurity'],
      published: '2023-08-21',
      year: '2023',
      journal: 'Southern Aquaculture Science',
      doi: '10.5555/sas.2023.0412',
      authors: ['Wen Li Chua', 'Rhys Pemberton', 'Anika Desai'],
      keyTakeaways: [
        'Pooled sampling of 30 prawns per pond detected infection at 2% prevalence.',
        'Median time from sampling to quarantine fell from 9 days to 3 days.',
        'No infected pond spread the virus to a neighbouring farm during the study.',
      ],
      quotesOfInterest: ['Speed of response mattered more than the sampling design.'],
    },
    `
## Abstract

White spot syndrome virus remains the most serious disease threat to farmed black tiger prawns. Over three seasons, four farms near Banksia Point sampled every pond fortnightly.

## Findings

Pooled sampling of 30 prawns per pond detected infection at 2% prevalence. Median time from sampling to quarantine fell from 9 days to 3 days once results were reported directly to farm managers. No infected pond spread the virus to a neighbouring farm during the study.
`,
    [
      {
        question: 'How quickly were infected ponds quarantined after surveillance improved?',
        evidence: 'Median time from sampling to quarantine fell from 9 days to 3 days',
      },
    ],
  ),
  resource(
    {
      id: 'sw-rock-lobster-handling',
      title: 'Post-harvest handling to reduce rock lobster mortality in live export',
      summary:
        'Trials of holding temperature, handling time and packing density for southern rock ' +
        'lobster bound for live export, with a handling protocol that cut deaths in transit.',
      type: 'document',
      kind: 'final-report',
      topicIds: ['post-harvest'],
      published: '2021-06-30',
      year: '2021',
      authors: ['Samuel Ngata', 'Isla Fenwick'],
      keyTakeaways: [
        'Holding lobsters at 10 to 12 degrees before packing cut transit deaths by 60%.',
        'Each extra hour on deck raised mortality by about 2%.',
        'Packing density above 18 kg per carton increased leg loss.',
      ],
      quotesOfInterest: ['Most of the losses happen before the carton is closed.'],
    },
    `
## Trials

Lobsters from the Southern Shelf were held at three temperatures and packed at three densities across 24 export consignments.

## Results

Holding lobsters at 10 to 12 degrees before packing cut transit deaths by 60%, and the benefit was largest in consignments packed during the 2019 marine heatwave. Each extra hour on deck raised mortality by about 2%, and packing density above 18 kg per carton increased leg loss.
`,
    [
      {
        question: 'What holding temperature reduced lobster deaths in transit?',
        evidence: 'Holding lobsters at 10 to 12 degrees before packing cut transit deaths by 60%.',
      },
    ],
  ),
  resource(
    {
      id: 'sw-lease-biosecurity',
      title: 'Biosecurity zoning between neighbouring aquaculture leases',
      summary:
        'A fact sheet for growers and regulators on separation distances, shared equipment ' +
        'rules and movement controls that reduce pathogen spread between oyster and prawn ' +
        'leases.',
      type: 'document',
      kind: 'fact-sheet',
      topicIds: ['aquaculture-biosecurity', 'fisheries-policy'],
      published: '2025-02-12',
      year: '2025',
      authors: ['Rhys Pemberton'],
      keyTakeaways: [
        'Leases at least 2 km apart had far fewer shared outbreaks.',
        'Shared boats and bins were the most common pathway between leases.',
        'Movement permits should record the source lease for every batch.',
      ],
      quotesOfInterest: ['Distance helps, but clean equipment helps more.'],
    },
    `
## Key points

- Leases at least 2 km apart had far fewer shared outbreaks.
- Shared boats and bins were the most common pathway between leases.
- Movement permits should record the source lease for every batch.

## Zoning

The Lease Zoning Pilot in Marlin Bay grouped leases into three zones with their own equipment and staff.
`,
    [
      {
        question: 'What was the most common pathway for disease between leases?',
        evidence: 'Shared boats and bins were the most common pathway between leases.',
      },
    ],
  ),
  resource(
    {
      id: 'sw-longline-bycatch',
      title: 'Seabird and turtle bycatch mitigation in pelagic longline fisheries',
      summary:
        'A comparison of night setting, weighted branch lines and circle hooks on the southern ' +
        'tuna longline fleet, measuring bycatch of seabirds and turtles against target catch.',
      type: 'document',
      kind: 'journal-article',
      topicIds: ['fisheries-policy', 'marine-sustainability'],
      published: '2020-10-05',
      year: '2020',
      journal: 'Temperate Fisheries Review',
      doi: '10.5555/tfr.2020.0187',
      authors: ['Helen Achterberg', 'Joel Mbeki', 'Isla Fenwick'],
      keyTakeaways: [
        'Night setting with weighted lines cut seabird bycatch by 85%.',
        'Circle hooks halved turtle hookings with no loss of tuna catch.',
        'Combined measures cost operators less than 3% of trip revenue.',
      ],
      quotesOfInterest: ['The best mitigation is the one crews actually use at 3 am.'],
    },
    `
## Abstract

Observers on 22 vessels recorded bycatch across 1,400 longline sets. Night setting with weighted lines cut seabird bycatch by 85%, and circle hooks halved turtle hookings with no loss of tuna catch.
`,
    [
      {
        question: 'How much did night setting reduce seabird bycatch?',
        evidence: 'Night setting with weighted lines cut seabird bycatch by 85%',
      },
    ],
  ),
  resource(
    {
      id: 'sw-snapper-assessment',
      title: 'Pink snapper stock assessment for the Eastern Gulf, 2023',
      summary:
        'The 2023 assessment of pink snapper in the Eastern Gulf, combining commercial catch, ' +
        'recreational survey and age data to estimate spawning biomass and rebuilding time.',
      type: 'document',
      kind: 'report',
      topicIds: ['stock-assessment'],
      published: '2023-12-01',
      year: '2023',
      authors: ['Helen Achterberg', 'Isla Fenwick'],
      keyTakeaways: [
        'Spawning biomass is estimated at 28% of unfished levels.',
        'The stock is classed as depleted but recovering.',
        'Rebuilding to 40% is projected to take 8 to 10 years at current catch.',
      ],
      quotesOfInterest: ['Recovery is under way, but it is slow and easily reversed.'],
    },
    `
## Stock status

Spawning biomass is estimated at 28% of unfished levels, and the stock is classed as depleted but recovering. Recruitment from the 2022 spawning season was weak, which coincided with a marine heatwave in the gulf. Rebuilding to 40% is projected to take 8 to 10 years at current catch.
`,
    [
      {
        question: 'What is the current spawning biomass of Eastern Gulf pink snapper?',
        evidence: 'Spawning biomass is estimated at 28% of unfished levels',
      },
    ],
  ),
  resource(
    {
      id: 'sw-oyster-mortality',
      title: 'Pacific oyster mortality syndrome: a response plan for growers',
      summary:
        'A step-by-step response plan for oyster growers when ostreid herpesvirus is suspected, ' +
        'covering reporting, stock movement, cleaning and restocking.',
      type: 'document',
      kind: 'fact-sheet',
      topicIds: ['aquaculture-biosecurity'],
      published: '2018-01-25',
      year: '2018',
      authors: ['Rhys Pemberton', 'Wen Li Chua'],
      keyTakeaways: [
        'Report suspected cases within 24 hours.',
        'Stop all stock movement off the lease until results are back.',
        'Restock only with spat from tested hatcheries.',
      ],
      quotesOfInterest: ['The first day decides how far it spreads.'],
    },
    `
## When you suspect an outbreak

Report suspected cases within 24 hours and stop all stock movement off the lease until results are back. Restock only with spat from tested hatcheries.
`,
    [
      {
        question: 'How soon should growers report a suspected outbreak?',
        evidence: 'Report suspected cases within 24 hours',
      },
    ],
  ),
  resource(
    {
      id: 'sw-cold-chain',
      title: 'Cold chain temperature logging for live seafood exports',
      summary: 'Guidance on placing temperature loggers through the export chain, from boat to ' +
        'airport, and on reading logger traces to find where product quality is lost.',
      type: 'web',
      kind: 'web-page',
      topicIds: ['post-harvest'],
      published: '2019-07-15',
      year: '2019',
      authors: ['Samuel Ngata'],
      keyTakeaways: [
        'Most temperature breaks happened at the airport, not on the road.',
        'One logger per pallet was enough to find the weak link.',
      ],
      quotesOfInterest: ['The logger trace tells you where to look, not who to blame.'],
    },
    `
## Where quality is lost

Most temperature breaks happened at the airport, not on the road. One logger per pallet was enough to find the weak link in 9 of 10 consignments.
`,
    [
      {
        question: 'Where did most temperature breaks happen in the export chain?',
        evidence: 'Most temperature breaks happened at the airport, not on the road.',
      },
    ],
  ),
  resource(
    {
      id: 'sw-abalone-comanagement',
      title: 'Co-management arrangements in small-scale abalone fisheries',
      summary:
        'A study of three abalone fishing zones where divers share responsibility for setting ' +
        'catch limits with the regulator, and what made those arrangements last.',
      type: 'document',
      kind: 'journal-article',
      topicIds: ['fisheries-policy'],
      published: '2017-05-02',
      year: '2017',
      journal: 'Temperate Fisheries Review',
      doi: '10.5555/tfr.2017.0044',
      authors: ['Mara Lindqvist', 'Daniel Arkwright'],
      keyTakeaways: [
        'Zones with diver-led surveys adjusted catch limits a season earlier.',
        'Trust built slowly and was lost quickly after one disputed decision.',
      ],
      quotesOfInterest: ['The divers saw the decline before the data did.'],
    },
    `
## Findings

Zones with diver-led surveys adjusted catch limits a season earlier than zones that relied on catch records alone. Trust built slowly and was lost quickly after one disputed decision.
`,
    [
      {
        question: 'Did diver-led surveys change how quickly catch limits were adjusted?',
        evidence:
          'Zones with diver-led surveys adjusted catch limits a season earlier than zones that ' +
          'relied on catch records alone.',
      },
    ],
  ),
  resource(
    {
      id: 'sw-recreational-survey',
      title: 'Recreational fishing survey of the southern bays, 2016',
      summary:
        'A survey of 2,100 recreational fishers across the southern bays, estimating catch of ' +
        'King George whiting, pink snapper and southern calamari and how often fish were ' +
        'released.',
      type: 'document',
      kind: 'final-report',
      topicIds: ['fisheries-policy', 'stock-assessment'],
      published: '2016-09-30',
      year: '2016',
      authors: ['Tomas Okafor', 'Anika Desai'],
      keyTakeaways: [
        'Recreational fishers took about 41% of the King George whiting catch.',
        'Almost half of all pink snapper caught were released.',
      ],
      quotesOfInterest: ['Recreational catch is too large to treat as a footnote.'],
    },
    `
## Results

Recreational fishers took about 41% of the King George whiting catch in the southern bays, and almost half of all pink snapper caught were released.
`,
    [
      {
        question: 'What share of the King George whiting catch was recreational?',
        evidence: 'Recreational fishers took about 41% of the King George whiting catch',
      },
    ],
  ),
  resource(
    {
      id: 'sw-seagrass-whiting',
      title: 'Seagrass meadows as nursery habitat for King George whiting',
      summary:
        'Seine-net surveys comparing juvenile whiting in intact and degraded seagrass across ' +
        'Marlin Bay, with implications for coastal development approvals.',
      type: 'document',
      kind: 'journal-article',
      topicIds: ['marine-sustainability'],
      published: '2021-11-11',
      year: '2021',
      journal: 'Temperate Fisheries Review',
      doi: '10.5555/tfr.2021.0311',
      authors: ['Priya Ramanathan', 'Mara Lindqvist'],
      keyTakeaways: [
        'Intact seagrass held five times more juvenile whiting than bare sand.',
        'Meadows near storm-water outlets lost a third of their area in a decade.',
      ],
      quotesOfInterest: ["Protecting the meadow is protecting next year's catch."],
    },
    `
## Results

Intact seagrass held five times more juvenile whiting than bare sand. Meadows near storm-water outlets lost a third of their area between 2011 and 2021, and the shallowest meadows thinned further after a summer heatwave.
`,
    [
      {
        question: 'How much more juvenile whiting did intact seagrass hold?',
        evidence: 'Intact seagrass held five times more juvenile whiting than bare sand.',
      },
    ],
  ),
]

const byId = new Map(DESIGN_RESOURCES.map((r) => [r.summary.id, r]))

/** A small, text-bearing PDF keeps the document harness on the real viewer path. */
function designPdf(): Uint8Array {
  const pages = [
    {
      heading: 'Marine heatwaves and greenlip abalone',
      lines: [
        'Southern Waters Research Institute | November 2024',
        '',
        'Summary',
        'The Reef Recruitment Monitoring Program surveyed greenlip abalone',
        'on 46 reef sites along the southern coast from 2019 to 2024.',
        'Juvenile density fell by 38% at sites with more than 21 days of',
        'water temperature above the local 90th percentile.',
        '',
        'Methods',
        'Pairs of divers counted juvenile abalone under 40 mm shell length',
        'along fixed 50 metre transects every autumn. Temperature loggers',
        'recorded water temperature every 30 minutes at 8 metres depth.',
      ],
    },
    {
      heading: 'Results by reef group',
      lines: [
        'Heatwave exposure and change in juvenile density, 2019 to 2024',
        '',
        'Reef group              Heatwave days      Density change',
        'Western Gulf reefs      64                 -52%',
        'Cape Wren               31                 -24%',
        'Tern Island             12                  -6%',
        '',
        'Recruitment recovered within two seasons where giant kelp canopy',
        'stayed intact. Where purple sea urchin barrens had replaced the',
        'kelp, juvenile counts stayed low for the rest of the survey.',
      ],
    },
    {
      heading: 'Recommendations for managers',
      lines: [
        'Repeat juvenile surveys in the autumn after any season with more',
        'than 21 heatwave days.',
        '',
        'Hold size-limit and quota changes until the repeat survey is in.',
        '',
        'Prioritise kelp protection on reefs that still carry a canopy.',
        '',
        'This fictional report is used only by the offline design harness.',
      ],
    },
  ]
  const escape = (value: string) => value.replace(/[\\()]/g, '\\$&')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [5 0 R 7 0 R 9 0 R] /Count 3 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
  ]
  for (const [index, page] of pages.entries()) {
    const stream = [
      `BT /F1 19 Tf 50 780 Td (${escape(page.heading)}) Tj ET`,
      'BT /F2 11 Tf 16 TL 50 744 Td',
      ...page.lines.map((line, i) => `${i ? 'T* ' : ''}(${escape(line)}) Tj`),
      'ET',
      `BT /F2 10 Tf 50 48 Td (Southern Waters | ${index + 1} of 3) Tj ET`,
    ].join('\n')
    objects.push(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ' +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + index * 2} 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    )
  }
  // All content is ASCII, so string offsets are also byte offsets in the xref.
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(pdf.length)
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(pdf)
}

const DESIGN_PDF_RESOURCE = DESIGN_RESOURCES[0]!.summary.id
const DESIGN_PDF_BYTES = designPdf()

// ---------------------------------------------------------------------------
// Text helpers: deterministic scoring and passage selection
// ---------------------------------------------------------------------------

const STOPWORDS = new Set(
  ('the and for are with from that this what how does into along over under about which ' +
    'their there been were have has its than then them they when where who why will can may ' +
    'latest research say says known affect affecting')
    .split(' '),
)

function stem(word: string): string {
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3)
  if (word.length > 4 && word.endsWith('es')) return word.slice(0, -2)
  if (word.length > 3 && word.endsWith('s')) return word.slice(0, -1)
  return word
}

function terms(text: string): string[] {
  return [
    ...new Set(
      text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOPWORDS.has(w))
        .map(stem),
    ),
  ]
}

function hits(text: string, wanted: string[]): number {
  const have = new Set(terms(text))
  return wanted.filter((t) => have.has(t)).length
}

/** The body's prose paragraphs, without headings, list markers or table rows. */
function paragraphs(body: string): string[] {
  return body.split(/\n\s*\n/).map((block) => block.trim())
    .filter((block) => block && !block.startsWith('#') && !block.startsWith('|'))
    .map((block) => block.replace(/^- /gm, '').replace(/\s*\n\s*/g, ' '))
}

/**
 * The body as a platform extraction reads it: no markdown, and a table as rows of cells separated
 * by spaces, the way text comes out of a PDF table.
 */
function plainText(body: string): string {
  return body.replace(/^#+\s+/gm, '').replace(/^- /gm, '')
    .split('\n').filter((line) => !/^\s*\|[\s:|-]+\|\s*$/.test(line))
    .map((line) =>
      line.trim().startsWith('|')
        ? line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim()).join('   ')
        : line
    ).join('\n')
}

function scored(
  record: DesignResource,
  relevance: number,
  wanted: string[],
  citedCount = 0,
): ScoredResource {
  const ranked = paragraphs(record.body).map((text, index) => ({
    text,
    page: index + 2,
    score: hits(text, wanted),
  })).sort((a, b) => b.score - a.score || a.page - b.page)
  const best = ranked[0]
  return {
    ...record.summary,
    relevance,
    citedCount,
    ...(best ? { matchedPassage: best.text, matchedPage: best.page, matchedField: 'body' } : {}),
    passages: ranked.slice(0, 3).map(({ text, page }) => ({ text, page })),
  }
}

/** Every resource the query's terms reach, best first, with relevance in [0.34, 0.96]. */
function rank(query: string, pool: DesignResource[]): ScoredResource[] {
  const wanted = terms(query)
  const scores = pool.map((record) => ({
    record,
    score: hits(record.summary.title, wanted) * 3 + hits(record.summary.summary, wanted) * 2 +
      Math.min(hits(record.body, wanted), 4),
  })).filter((s) => s.score > 0)
  const top = Math.max(1, ...scores.map((s) => s.score))
  return scores.sort((a, b) =>
    b.score - a.score || a.record.summary.id.localeCompare(b.record.summary.id)
  )
    .map((s) => scored(s.record, Math.round((0.34 + 0.62 * s.score / top) * 100) / 100, wanted))
}

// ---------------------------------------------------------------------------
// The streamed answer
// ---------------------------------------------------------------------------

const ANSWER_TEXT = [
  `${HEATWAVE_LEAD} [1] ${HEATWAVE_FINDING} [1] ${HEATWAVE_LAG} [1]`,
  '| Reef group | Heatwave days (2019-2024) | Change in juvenile density |\n' +
  '| --- | --- | --- |\n' +
  '| Western Gulf reefs | 64 | -52% |\n' +
  '| Cape Wren | 31 | -24% |\n' +
  '| Tern Island | 12 | -6% |',
  `${OUTLOOK_LEAD} [2] ${OUTLOOK_FINDING} [2] ${OUTLOOK_RISK} [2]`,
  `${KELP_LEAD} [3] ${KELP_FINDING} [3] ${KELP_ADVICE} [3]`,
].join('\n\n')

const CITED = [
  { index: 1, id: 'sw-abalone-heatwaves', passage: HEATWAVE_FINDING },
  { index: 2, id: 'sw-warming-outlook-2026', passage: OUTLOOK_FINDING },
  { index: 3, id: 'sw-kelp-restoration', passage: KELP_FINDING },
] as const

/** Split text into small deterministic chunks, as a token stream would arrive. */
function chunks(text: string): string[] {
  return text.match(/\S+\s*|\s+/g) ?? [text]
}

/** A short answer about one document, for the document page's own chat. */
function documentAnswer(record: DesignResource): { text: string; passage: string } {
  const passage = record.questions[0]?.evidence ?? paragraphs(record.body)[0] ??
    record.summary.summary
  return {
    passage,
    text: `This document's central finding is direct: ${passage.replace(/\.$/, '')} [1]. ` +
      `It sits within ${record.summary.title.toLowerCase()} [1].`,
  }
}

// ---------------------------------------------------------------------------
// The reader-facing provider
// ---------------------------------------------------------------------------

const KIND_DEFINITIONS: Record<string, string> = {
  'report': 'A technical or project report from the institute or its partners.',
  'final-report': 'The final report of a funded research project.',
  'journal-article': 'A peer-reviewed article published in a journal.',
  'fact-sheet': 'A short practical summary written for growers, fishers or managers.',
  'web-page': 'A page from the institute website or a partner site.',
}

const TOPIC_DEFINITIONS: Record<string, string> = {
  'stock-assessment': 'Estimating the size, health and productivity of fished stocks.',
  'aquaculture-biosecurity': 'Keeping pathogens out of farms and stopping spread between them.',
  'post-harvest': 'Handling, storage, transport and quality from catch to market.',
  'marine-sustainability': 'Habitat, climate and ecosystem effects on marine resources.',
  'fisheries-policy': 'Rules, management arrangements and how decisions are made.',
}

export const DESIGN_LABELSETS: Labelset[] = [
  {
    id: 'topic',
    title: 'Topic',
    multiple: true,
    labels: Object.keys(TOPIC_DEFINITIONS),
    definitions: TOPIC_DEFINITIONS,
    kind: 'RESOURCES',
  },
  {
    id: 'kind',
    title: 'Kind',
    multiple: false,
    labels: Object.keys(KIND_DEFINITIONS),
    definitions: KIND_DEFINITIONS,
    kind: 'RESOURCES',
  },
]

function catalogItem(record: DesignResource): CatalogItem {
  const s = record.summary
  return {
    id: s.id,
    title: s.title,
    status: 'processed',
    created: `${s.published}T09:00:00.000Z`,
    topicIds: s.topicIds,
    ...(s.kind ? { kind: s.kind } : {}),
    type: s.type,
    ...(s.published ? { published: s.published } : {}),
    summary: s.summary,
    ...(s.sourceName ? { sourceName: s.sourceName } : {}),
    enriched: true,
    ...(s.authors ? { authors: s.authors } : {}),
    ...(s.journal ? { journal: s.journal } : {}),
    ...(s.year ? { year: s.year } : {}),
    ...(s.doi ? { doi: s.doi } : {}),
  }
}

export class DesignProvider extends DoubleProvider {
  protected override resources: ResourceSummary[] = DESIGN_RESOURCES.map((r) => r.summary)

  /** The corpus belongs to the marine portal; any other portal's collection is empty. */
  override listResources(tenant: TenantConfig): Promise<ResourceSummary[]> {
    return Promise.resolve(tenant.slug === 'marine' ? this.resources : [])
  }

  override search(
    _tenant: TenantConfig,
    query: string,
    opts: SearchOptions = {},
  ): Promise<SearchResults> {
    const pool = DESIGN_RESOURCES.filter((r) =>
      (!opts.resourceIds?.length || opts.resourceIds.includes(r.summary.id)) &&
      (!opts.topicIds?.length || r.summary.topicIds.some((t) => opts.topicIds!.includes(t))) &&
      (!opts.kindIds?.length || opts.kindIds.includes(r.summary.kind ?? ''))
    )
    if (opts.docScope) return Promise.resolve({ query, resources: [], relatedQuestions: [] })
    const resources = rank(query, pool).slice(0, opts.pageSize ?? 20)
    const wanted = terms(query)
    return Promise.resolve({
      query,
      resources,
      relatedQuestions: [
        { id: 'rq-1', text: 'Which reefs recovered fastest after the 2022 heatwave?' },
        { id: 'rq-2', text: 'How is kelp restoration helping abalone recruitment?' },
        { id: 'rq-3', text: 'What harvest settings change after a heatwave year?' },
      ].filter((_, i) => wanted.length > 0 || i === 0),
    })
  }

  override suggest(tenant: TenantConfig, query?: string): Promise<Question[]> {
    const questions = tenant.suggestedQuestions
    if (!query) return Promise.resolve(questions)
    const wanted = terms(query)
    return Promise.resolve(
      [...questions].sort((a, b) => hits(b.text, wanted) - hits(a.text, wanted)),
    )
  }

  override catalog(_tenant: TenantConfig, opts: CatalogOptions = {}): Promise<CatalogPage> {
    const wanted = opts.query ? terms(opts.query) : []
    let items = DESIGN_RESOURCES.filter((r) =>
      (!wanted.length || hits(`${r.summary.title} ${r.summary.summary}`, wanted) > 0) &&
      (!opts.topicIds?.length || r.summary.topicIds.some((t) => opts.topicIds!.includes(t))) &&
      (!opts.kindIds?.length || opts.kindIds.includes(r.summary.kind ?? ''))
    ).map(catalogItem)
    const field = opts.sortField ?? 'published'
    const direction = opts.sortOrder === 'asc' ? 1 : -1
    items = items.sort((a, b) => {
      const key = (item: CatalogItem) =>
        field === 'title'
          ? item.title
          : field === 'published'
          ? item.published ?? ''
          : item.created ?? ''
      return key(a).localeCompare(key(b)) * direction || a.id.localeCompare(b.id)
    })
    const size = opts.pageSize ?? 24
    const page = opts.page ?? 0
    return Promise.resolve({
      items: items.slice(page * size, page * size + size),
      total: items.length,
    })
  }

  override topicResources(
    _tenant: TenantConfig,
    topicId: string,
    limit = DESIGN_RESOURCES.length,
  ): Promise<ResourceSummary[]> {
    return Promise.resolve(
      DESIGN_RESOURCES.map((r) => r.summary).filter((r) => r.topicIds.includes(topicId))
        .sort((a, b) => (b.published ?? '').localeCompare(a.published ?? ''))
        .slice(0, limit),
    )
  }

  override facets(_tenant: TenantConfig, labelsets: string[]): Promise<FacetCounts> {
    const counts: FacetCounts = {}
    for (const labelset of labelsets) {
      const tally: Record<string, number> = {}
      for (const { summary } of DESIGN_RESOURCES) {
        const labels = labelset === 'topic'
          ? summary.topicIds
          : labelset === 'kind' && summary.kind
          ? [summary.kind]
          : []
        for (const label of labels) tally[label] = (tally[label] ?? 0) + 1
      }
      if (labelset === 'topic' || labelset === 'kind') counts[labelset] = tally
    }
    return Promise.resolve(counts)
  }

  untaggedCount(_tenant: TenantConfig, _labelset: string): Promise<number> {
    return Promise.resolve(0)
  }

  override labelsets(_tenant: TenantConfig): Promise<Labelset[]> {
    return Promise.resolve(structuredClone(DESIGN_LABELSETS))
  }

  override async *ask(
    _tenant: TenantConfig,
    query: string,
    opts: AskOptions = {},
  ): AsyncIterable<AskEvent> {
    const scope = opts.resourceId ? byId.get(opts.resourceId) : undefined
    const wanted = terms(query)
    yield { type: 'stage', stage: 'preprocessing', status: 'started' }
    yield { type: 'stage', stage: 'preprocessing', status: 'completed' }
    yield { type: 'stage', stage: 'retrieval', status: 'started' }
    const cited: { index: number; record: DesignResource; passage: string }[] = scope
      ? [{ index: 1, record: scope, passage: documentAnswer(scope).passage }]
      : CITED.map((c) => ({ index: c.index, record: byId.get(c.id)!, passage: c.passage }))
    const extra = scope ? [] : ['sw-abalone-comanagement', 'sw-seagrass-whiting']
    const sources: ScoredResource[] = [
      ...cited.map((c, i) => ({
        ...scored(c.record, [0.94, 0.87, 0.81][i] ?? 0.8, wanted, 1),
        matchedPassage: c.passage,
      })),
      ...extra.map((id, i) => scored(byId.get(id)!, [0.52, 0.47][i] ?? 0.4, wanted)),
    ]
    yield { type: 'sources', resources: sources }
    // The platform's learning id is what lets a reader rate the answer.
    yield { type: 'learning', id: 'design-fixture-learning-1' }
    yield { type: 'stage', stage: 'retrieval', status: 'completed' }
    yield { type: 'stage', stage: 'generating', status: 'started' }
    const text = scope ? documentAnswer(scope).text : ANSWER_TEXT
    for (const piece of chunks(text)) yield { type: 'delta', text: piece }
    for (const c of cited) {
      const citation: Citation = {
        index: c.index,
        resourceId: c.record.summary.id,
        title: c.record.summary.title,
        passage: c.passage,
      }
      yield { type: 'citation', citation }
    }
    yield { type: 'stage', stage: 'generating', status: 'completed' }
    yield { type: 'stage', stage: 'auditing', status: 'started', figures: 14 }
    yield {
      type: 'audit',
      figuresChecked: 14,
      figuresUnsupported: [],
      yearsUnsupported: [],
      contraindicationsUnsupported: [],
      sentencesChecked: 9,
      sentencesCited: 9,
    }
    yield { type: 'stage', stage: 'auditing', status: 'completed' }
    yield { type: 'stage', stage: 'validating', status: 'started' }
    yield { type: 'stage', stage: 'validating', status: 'completed' }
    yield { type: 'quality', answerRelevance: 4.6, groundedness: 4.8, contextRelevance: 4.3 }
    yield { type: 'done', refused: false, text }
  }
}

// ---------------------------------------------------------------------------
// The knowledge graph
// ---------------------------------------------------------------------------

const GROUPS: Record<string, string[]> = {
  Species: [
    'Greenlip abalone',
    'Blacklip abalone',
    'Southern rock lobster',
    'Black tiger prawn',
    'Pacific oyster',
    'Pink snapper',
    'King George whiting',
    'Giant kelp',
    'Purple sea urchin',
  ],
  Pathogen: [
    'White spot syndrome virus',
    'Ostreid herpesvirus 1',
    'Abalone viral ganglioneuritis',
    'Perkinsus olseni',
    'Vibrio harveyi',
  ],
  Location: [
    'Eastern Gulf',
    'Western Gulf reefs',
    'Banksia Point',
    'Cape Wren',
    'Tern Island',
    'Marlin Bay',
    'Southern Shelf',
  ],
  Project: [
    'Reef Recruitment Monitoring Program',
    'Kelp Forest Recovery Trial',
    'Prawn Health Surveillance Network',
    'Live Export Quality Project',
    'Lease Zoning Pilot',
    'Gulf Snapper Assessment',
    'Longline Bycatch Study',
  ],
  Researcher: [
    'Mara Lindqvist',
    'Tomas Okafor',
    'Priya Ramanathan',
    'Helen Achterberg',
    'Wen Li Chua',
    'Rhys Pemberton',
    'Samuel Ngata',
    'Isla Fenwick',
  ],
  Organisation: [
    'Southern Waters Research Institute',
    'Coastal Fisheries Authority',
    'Marine Biosecurity Council',
    'Gulf Fishers Cooperative',
    'Ocean Futures Fund',
  ],
}

const RELATIONS: [string, string, string][] = [
  ['Mara Lindqvist', 'studies', 'Greenlip abalone'],
  ['Mara Lindqvist', 'studies', 'Blacklip abalone'],
  ['Mara Lindqvist', 'studies', 'Reef Recruitment Monitoring Program'],
  ['Tomas Okafor', 'studies', 'Greenlip abalone'],
  ['Tomas Okafor', 'studies', 'Giant kelp'],
  ['Priya Ramanathan', 'studies', 'Purple sea urchin'],
  ['Priya Ramanathan', 'studies', 'Giant kelp'],
  ['Priya Ramanathan', 'studies', 'Kelp Forest Recovery Trial'],
  ['Helen Achterberg', 'studies', 'Pink snapper'],
  ['Helen Achterberg', 'studies', 'King George whiting'],
  ['Helen Achterberg', 'studies', 'Gulf Snapper Assessment'],
  ['Wen Li Chua', 'studies', 'Black tiger prawn'],
  ['Wen Li Chua', 'studies', 'White spot syndrome virus'],
  ['Wen Li Chua', 'studies', 'Prawn Health Surveillance Network'],
  ['Rhys Pemberton', 'studies', 'Pacific oyster'],
  ['Rhys Pemberton', 'studies', 'Ostreid herpesvirus 1'],
  ['Samuel Ngata', 'studies', 'Southern rock lobster'],
  ['Samuel Ngata', 'studies', 'Live Export Quality Project'],
  ['Isla Fenwick', 'studies', 'Pink snapper'],
  ['Isla Fenwick', 'studies', 'Southern rock lobster'],
  ['White spot syndrome virus', 'infects', 'Black tiger prawn'],
  ['Ostreid herpesvirus 1', 'infects', 'Pacific oyster'],
  ['Abalone viral ganglioneuritis', 'infects', 'Greenlip abalone'],
  ['Abalone viral ganglioneuritis', 'infects', 'Blacklip abalone'],
  ['Perkinsus olseni', 'infects', 'Blacklip abalone'],
  ['Vibrio harveyi', 'infects', 'Southern rock lobster'],
  ['Vibrio harveyi', 'infects', 'Black tiger prawn'],
  ['Greenlip abalone', 'located-in', 'Western Gulf reefs'],
  ['Blacklip abalone', 'located-in', 'Cape Wren'],
  ['Giant kelp', 'located-in', 'Tern Island'],
  ['Purple sea urchin', 'located-in', 'Tern Island'],
  ['Pink snapper', 'located-in', 'Eastern Gulf'],
  ['King George whiting', 'located-in', 'Marlin Bay'],
  ['Southern rock lobster', 'located-in', 'Southern Shelf'],
  ['Black tiger prawn', 'located-in', 'Banksia Point'],
  ['Pacific oyster', 'located-in', 'Marlin Bay'],
  ['Reef Recruitment Monitoring Program', 'located-in', 'Western Gulf reefs'],
  ['Kelp Forest Recovery Trial', 'located-in', 'Tern Island'],
  ['Lease Zoning Pilot', 'located-in', 'Marlin Bay'],
  ['Gulf Snapper Assessment', 'located-in', 'Eastern Gulf'],
  ['Longline Bycatch Study', 'located-in', 'Southern Shelf'],
  ['Gulf Fishers Cooperative', 'located-in', 'Eastern Gulf'],
  ['Southern Waters Research Institute', 'located-in', 'Cape Wren'],
  ['Reef Recruitment Monitoring Program', 'funded-by', 'Ocean Futures Fund'],
  ['Reef Recruitment Monitoring Program', 'funded-by', 'Southern Waters Research Institute'],
  ['Kelp Forest Recovery Trial', 'funded-by', 'Ocean Futures Fund'],
  ['Prawn Health Surveillance Network', 'funded-by', 'Marine Biosecurity Council'],
  ['Lease Zoning Pilot', 'funded-by', 'Marine Biosecurity Council'],
  ['Live Export Quality Project', 'funded-by', 'Gulf Fishers Cooperative'],
  ['Gulf Snapper Assessment', 'funded-by', 'Coastal Fisheries Authority'],
  ['Longline Bycatch Study', 'funded-by', 'Coastal Fisheries Authority'],
  ['Gulf Snapper Assessment', 'assesses', 'Pink snapper'],
  ['Reef Recruitment Monitoring Program', 'assesses', 'Greenlip abalone'],
  ['Reef Recruitment Monitoring Program', 'assesses', 'Blacklip abalone'],
  ['Kelp Forest Recovery Trial', 'assesses', 'Purple sea urchin'],
  ['Prawn Health Surveillance Network', 'assesses', 'Black tiger prawn'],
  ['Lease Zoning Pilot', 'assesses', 'Pacific oyster'],
  ['Live Export Quality Project', 'assesses', 'Southern rock lobster'],
  ['Coastal Fisheries Authority', 'assesses', 'Southern rock lobster'],
  ['Coastal Fisheries Authority', 'assesses', 'King George whiting'],
  ['Marine Biosecurity Council', 'assesses', 'White spot syndrome virus'],
  ['Marine Biosecurity Council', 'assesses', 'Ostreid herpesvirus 1'],
]

const groupOf = new Map(
  Object.entries(GROUPS).flatMap(([group, names]) => names.map((name) => [name, group] as const)),
)

type GraphNode = { id: string; group: string; weight: number }
type GraphEdge = { source: string; target: string; label: string }

/** The relations graph, or one entity's neighbourhood: weight is each node's degree. */
export function designGraph(entity?: string): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const wanted = entity?.trim().toLowerCase()
  const edges = RELATIONS.filter(([s, , t]) =>
    !wanted || s.toLowerCase() === wanted || t.toLowerCase() === wanted
  ).map(([source, label, target]) => ({ source, target, label }))
  const degree = new Map<string, number>()
  for (const [s, , t] of RELATIONS) {
    degree.set(s, (degree.get(s) ?? 0) + 1)
    degree.set(t, (degree.get(t) ?? 0) + 1)
  }
  const ids = new Set(edges.flatMap((e) => [e.source, e.target]))
  const nodes = [...ids].map((id) => ({
    id,
    group: groupOf.get(id) ?? 'Organisation',
    weight: degree.get(id) ?? 1,
  })).sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id))
  return { nodes, edges }
}

// ---------------------------------------------------------------------------
// The management surface
// ---------------------------------------------------------------------------

const RECENT: RecentResource[] = [
  {
    id: 'sw-avg-field-notes-2026',
    title: 'Abalone viral ganglioneuritis field notes, autumn 2026',
    status: 'pending',
    created: '2026-10-16T23:40:00.000Z',
  },
  {
    id: 'sw-kelp-restoration',
    title: 'Restoring giant kelp forests after purple sea urchin barrens',
    status: 'processed',
    created: '2026-10-15T04:12:00.000Z',
  },
  {
    id: 'sw-marlin-bay-survey-sheets',
    title: 'Scanned survey sheets, Marlin Bay 1998',
    status: 'error',
    created: '2026-10-14T01:05:00.000Z',
  },
  {
    id: 'sw-warming-outlook-2026',
    title: 'Southern ocean warming outlook for fisheries, 2026 to 2035',
    status: 'processed',
    created: '2026-10-12T22:30:00.000Z',
  },
  {
    id: 'sw-lease-biosecurity',
    title: 'Biosecurity zoning between neighbouring aquaculture leases',
    status: 'processed',
    created: '2026-10-09T06:45:00.000Z',
    hidden: true,
  },
  {
    id: 'sw-abalone-heatwaves',
    title: 'Marine heatwaves and greenlip abalone recruitment on the southern coast',
    status: 'processed',
    created: '2026-10-07T03:20:00.000Z',
  },
  {
    id: 'sw-snapper-assessment',
    title: 'Pink snapper stock assessment for the Eastern Gulf, 2023',
    status: 'processed',
    created: '2026-10-02T05:00:00.000Z',
  },
  {
    id: 'sw-white-spot-prawn',
    title: 'White spot syndrome virus surveillance in farmed black tiger prawns',
    status: 'processed',
    created: '2026-09-29T00:15:00.000Z',
  },
]

const AGENTS: KbAgent[] = [
  { id: 'agent-topic-labeller', task: 'labeler', title: 'Topic classifier' },
  { id: 'agent-kind-labeller', task: 'labeler', title: 'Document kind classifier' },
  { id: 'agent-marine-graph', task: 'llm-graph', title: 'Marine entity graph' },
  { id: 'agent-research-summary', task: 'ask', title: 'Research summary enrichment' },
]

const ENTITY_DESCRIPTIONS: Record<string, string> = {
  Species: 'A fished, farmed or habitat-forming marine species, by its common name.',
  Pathogen: 'A virus, bacterium or parasite that causes disease in a marine species.',
  Location: 'A named reef, bay, gulf, island or shelf area.',
  Project: 'A named research or monitoring project.',
  Researcher: 'A named researcher or author.',
  Organisation: 'A research institute, regulator, industry body or funder.',
}

function agentConfigs() {
  return AGENTS.map((agent) => ({
    id: agent.id,
    task: agent.task,
    title: agent.title,
    model: 'fixture-extraction-model',
    on: 0,
    filter: { field_types: ['file', 'text', 'link'] },
    operations: agent.task === 'llm-graph'
      ? [{ graph: { entity_defs: Object.keys(ENTITY_DESCRIPTIONS) } }]
      : agent.task === 'labeler'
      ? [{ label: { labelset: agent.id.includes('topic') ? 'topic' : 'kind' } }]
      : [{ ask: { destination: 'research-summary' } }],
    enabled: true,
  }))
}

function graphStrategy() {
  return {
    taskId: 'agent-marine-graph',
    title: 'Marine entity graph',
    ident: 'marine-graph',
    entityDefs: Object.entries(ENTITY_DESCRIPTIONS).map(([label, description]) => ({
      label,
      description,
    })),
    examples: [
      {
        text:
          'The Reef Recruitment Monitoring Program, funded by the Ocean Futures Fund, assessed ' +
          'greenlip abalone on the Western Gulf reefs.',
        entities: [
          { name: 'Reef Recruitment Monitoring Program', label: 'Project' },
          { name: 'Ocean Futures Fund', label: 'Organisation' },
          { name: 'Greenlip abalone', label: 'Species' },
          { name: 'Western Gulf reefs', label: 'Location' },
        ],
        relations: [
          {
            source: 'Reef Recruitment Monitoring Program',
            target: 'Ocean Futures Fund',
            label: 'funded-by',
          },
          {
            source: 'Reef Recruitment Monitoring Program',
            target: 'Greenlip abalone',
            label: 'assesses',
          },
          { source: 'Greenlip abalone', target: 'Western Gulf reefs', label: 'located-in' },
        ],
      },
      {
        text: 'White spot syndrome virus infects black tiger prawns farmed near Banksia Point.',
        entities: [
          { name: 'White spot syndrome virus', label: 'Pathogen' },
          { name: 'Black tiger prawn', label: 'Species' },
          { name: 'Banksia Point', label: 'Location' },
        ],
        relations: [
          { source: 'White spot syndrome virus', target: 'Black tiger prawn', label: 'infects' },
          { source: 'Black tiger prawn', target: 'Banksia Point', label: 'located-in' },
        ],
      },
    ],
  }
}

function resourceContent(id: string): ResourceContent | null {
  const record = byId.get(id)
  if (!record) return null
  const s = record.summary
  return {
    id: s.id,
    title: s.title,
    kind: s.id === DESIGN_PDF_RESOURCE ? 'pdf' : s.type === 'web' ? 'web' : 'text',
    originUrl: s.originUrl,
    summary: s.summary,
    ...(s.sourceName ? { sourceName: s.sourceName } : {}),
    keyTakeaways: s.keyTakeaways ?? [],
    quotesOfInterest: s.quotesOfInterest ?? [],
    enriched: true,
    texts: [{ fieldId: 'body', text: record.body }],
    transcript: [],
    files: s.id === DESIGN_PDF_RESOURCE
      ? [{ group: 'file', fieldId: 'report', contentType: 'application/pdf' }]
      : [],
  }
}

function resourceExtraction(id: string) {
  const record = byId.get(id)
  const text = record ? plainText(record.body) : ''
  return {
    status: record ? 'PROCESSED' : 'PENDING',
    text,
    chars: text.length,
    paragraphs: record ? paragraphs(record.body).length : 0,
    tableRows: (text.match(/^\|/gm) ?? []).length,
  }
}

function corpusHealth() {
  return DESIGN_RESOURCES.map(({ summary, body }) => ({
    id: summary.id,
    title: summary.title,
    words: body.split(/\s+/).length * 18,
    status: 'ok' as 'ok' | 'thin' | 'challenge',
    hidden: false,
  })).concat([
    {
      id: 'sw-marlin-bay-survey-sheets',
      title: 'Scanned survey sheets, Marlin Bay 1998',
      words: 42,
      status: 'thin',
      hidden: false,
    },
    {
      id: 'sw-harbour-notice',
      title: 'Access check required',
      words: 18,
      status: 'challenge',
      hidden: true,
    },
  ])
}

function typeahead(query: string) {
  const q = query.trim().toLowerCase()
  const starts = (value: string) =>
    value.toLowerCase().split(/[^a-z0-9]+/).some((word) => word.startsWith(q))
  return {
    entities: [...groupOf.keys()].filter(starts).slice(0, 8),
    titles: DESIGN_RESOURCES.map((r) => r.summary.title).filter(starts).slice(0, 6),
  }
}

function askStructured(schema: { name?: string } | undefined, options?: { resourceId?: string }) {
  if (schema?.name === 'suggested_questions') {
    const record = options?.resourceId ? byId.get(options.resourceId) : undefined
    return { object: { questions: record?.questions ?? [] }, sources: [] }
  }
  if (schema?.name === 'research_subquestions') return { object: { questions: [] }, sources: [] }
  return {
    object: {
      score: 5,
      reason: 'Complete extraction',
      questions: [],
      suggestions: [],
      topics: [],
      kinds: [],
      assignments: [],
    },
    sources: [],
  }
}

/**
 * The management surface the Manage tabs, the graph, entity and document pages call, as a proxy
 * so an operation the fixture does not model is visible: it is logged to stderr once and answers
 * an empty list rather than failing the page.
 */
export function designManagement(
  log: (message: string) => void = (message) => console.error(message),
): NonNullable<BuildAppOptions['management']> {
  const unknown = new Set<string>()
  const handlers: Record<string, (...args: unknown[]) => unknown> = {
    counters: () =>
      Promise.resolve({ resources: 14, paragraphs: 1868, sentences: 9412, indexMb: 41.6 }),
    resourceCount: () => Promise.resolve(DESIGN_RESOURCES.length),
    listResources: () => Promise.resolve(DESIGN_RESOURCES.map((r) => r.summary)),
    recentResources: (_config, limit) =>
      Promise.resolve(RECENT.slice(0, typeof limit === 'number' ? limit : RECENT.length)),
    resource: (_config, id) => Promise.resolve(byId.get(String(id))?.summary ?? null),
    resourceFull: (_config, id) => Promise.resolve(resourceContent(String(id))),
    resourceContent: (_config, id) => Promise.resolve(resourceContent(String(id))),
    resourceExtraction: (_config, id) => Promise.resolve(resourceExtraction(String(id))),
    corpusHealth: () => Promise.resolve(corpusHealth()),
    labelsets: () => Promise.resolve(structuredClone(DESIGN_LABELSETS)),
    listAgents: () => Promise.resolve(structuredClone(AGENTS)),
    agentConfigs: () => Promise.resolve(agentConfigs()),
    graphStrategy: () => Promise.resolve(graphStrategy()),
    relationsGraph: (_config, options) =>
      Promise.resolve(designGraph((options as { entity?: string } | undefined)?.entity)),
    entityGroups: () =>
      Promise.resolve(Object.entries(GROUPS).map(([group, entities]) => ({ group, entities }))),
    typeahead: (_config, query) => Promise.resolve(typeahead(String(query ?? ''))),
    graphData: (_config, primary, secondary) =>
      Promise.resolve({
        primary: String(primary),
        secondary: String(secondary),
        nodes: [
          ...DESIGN_LABELSETS[0]!.labels.map((id) => ({
            id,
            label: id,
            group: 'primary' as const,
            weight: DESIGN_RESOURCES.filter((r) => r.summary.topicIds.includes(id)).length,
          })),
          ...DESIGN_LABELSETS[1]!.labels.map((id) => ({
            id,
            label: id,
            group: 'secondary' as const,
            weight: DESIGN_RESOURCES.filter((r) => r.summary.kind === id).length,
          })),
        ],
        edges: DESIGN_RESOURCES.flatMap((r) =>
          r.summary.topicIds.map((t) => ({ source: t, target: r.summary.kind ?? '', weight: 1 }))
        ),
      }),
    listExtractionMethods: () =>
      Promise.resolve([
        { id: 'default', name: 'Default', kind: 'default' },
        { id: 'tables', name: 'table-aware', kind: 'tables' },
        { id: 'visual', name: 'visual-transcribe', kind: 'visual', model: 'fixture-vision-model' },
      ]),
    listSearchConfigs: () =>
      Promise.resolve({
        'portal-search': { kind: 'find', config: { features: ['keyword', 'semantic'], top_k: 20 } },
        'portal-ask': { kind: 'ask', config: { features: ['keyword', 'semantic'], top_k: 20 } },
        'portal-docs': { kind: 'ask', config: { features: ['semantic'], top_k: 8 } },
      }),
    ensureSearchConfigs: () => Promise.resolve([]),
    augmentationModel: () => Promise.resolve('fixture-extraction-model'),
    generativeModel: () => Promise.resolve('fixture-answer-model'),
    hasSlug: () => Promise.resolve(false),
    thumbnailResponse: () => Promise.resolve(new Response(null, { status: 404 })),
    fileStream: (_config, id, fieldId) =>
      Promise.resolve(
        id === DESIGN_PDF_RESOURCE && fieldId === 'report'
          ? new Response(DESIGN_PDF_BYTES.slice(), {
            headers: {
              'content-type': 'application/pdf',
              'content-length': String(DESIGN_PDF_BYTES.length),
            },
          })
          : new Response('Fixture bytes: the design corpus has no original files.', {
            headers: { 'content-type': 'text/plain' },
          }),
      ),
    askStructured: (_config, schema, _prompt, options) =>
      Promise.resolve(
        askStructured(schema as { name?: string }, options as { resourceId?: string }),
      ),
    rephrase: () => Promise.resolve(null),
    summarize: () => Promise.resolve(null),
    feedback: () => Promise.resolve(),
    invalidate: () => undefined,
    uploadFile: () => Promise.resolve({ id: crypto.randomUUID() }),
    createLink: () => Promise.resolve({ id: crypto.randomUUID() }),
    createText: () => Promise.resolve({ id: crypto.randomUUID() }),
    patchResourceMeta: () => Promise.resolve(),
    deleteResource: () => Promise.resolve(),
    setResourceHidden: () => Promise.resolve(),
  }
  return new Proxy({}, {
    get: (_target, property) => {
      // Never thenable, never a symbol-keyed protocol: only named operations answer.
      if (typeof property !== 'string' || property === 'then') return undefined
      return (...args: unknown[]) => {
        const handler = handlers[property]
        if (handler) return handler(...args)
        if (!unknown.has(property)) {
          unknown.add(property)
          log(`[design-fixture] unmodelled management method: ${property}`)
        }
        return Promise.resolve([])
      }
    },
  }) as NonNullable<BuildAppOptions['management']>
}
