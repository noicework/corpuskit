import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { classifyStudyDesign, isStudyDesignId, studyDesignLabel } from './study-design.ts'

/**
 * The persona corpus (O'Neill loop 1, finding D1-06): the kinds the labeller
 * got wrong, each with the design the paper states about itself.
 */
const kindOf = (input: Parameters<typeof classifyStudyDesign>[0]) => classifyStudyDesign(input)?.id

describe('classifyStudyDesign - the persona corpus', () => {
  it('reads a pooled analysis as a pooled analysis, not a systematic review (EXPERIENCE)', () => {
    expect(kindOf({
      title:
        'Effectiveness and Tolerability of 12-Month Brivaracetam in the Real World: EXPERIENCE, an International Pooled Analysis',
      abstract:
        'EXPERIENCE was an international pooled analysis of retrospective studies of brivaracetam in clinical practice.',
      label: 'systematic-review',
    })).toBe('pooled-analysis')
  })

  it('PERMIT is a pooled analysis', () => {
    expect(kindOf({
      title:
        'PERMIT study: a global pooled analysis study of the effectiveness and tolerability of perampanel in routine clinical practice',
      abstract:
        'The PERaMpanel pooled analysIs of effecTiveness and tolerability (PERMIT) study was a pooled analysis of data from 44 real-world studies from 17 countries.',
      label: 'systematic-review',
    })).toBe('pooled-analysis')
  })

  it('an animal study is preclinical even when the labeller said trial (rat MRI harmonisation)', () => {
    expect(kindOf({
      title:
        'Harmonization of pipeline for preclinical multicenter MRI biomarker discovery in a rat model of post-traumatic epileptogenesis',
      abstract:
        'EpiBioS4Rx is a pioneering multicenter trial investigating preclinical imaging biomarkers. Adult, male rats underwent a lateral fluid percussion injury.',
      keywords: ['Animals', 'Rats', 'Disease Models, Animal'],
      label: 'randomised-controlled-trial',
    })).toBe('preclinical')
  })

  it('a nested case-control study is a case-control study (SUDEP with lamotrigine)', () => {
    expect(kindOf({
      title:
        'Risk of sudden unexpected death in epilepsy (SUDEP) with lamotrigine and other sodium channel-modulating antiseizure medications',
      abstract:
        'Methods This retrospective, nested case-control study identified 101 SUDEP cases and 199 living epilepsy controls.',
      keywords: ['Case-Control Studies', 'Retrospective Studies'],
      label: 'randomised-controlled-trial',
    })).toBe('case-control-study')
  })

  it('an observational cohort study is a cohort study (multiday heart-rate cycles)', () => {
    expect(kindOf({
      title:
        'Multiday cycles of heart rate are associated with seizure likelihood: An observational cohort study',
      abstract:
        'Methods We report the results from a non-interventional, observational cohort study.',
      label: 'randomised-controlled-trial',
    })).toBe('cohort-study')
  })

  it('a multicentre cohort is a cohort study (rituximab in anti-NMDAR)', () => {
    expect(kindOf({
      title:
        'Rituximab Use for Relapse Prevention in Anti-NMDAR Antibody-Mediated Encephalitis: A Multicenter Cohort Study',
      keywords: ['Cohort Studies', 'Humans'],
      label: 'randomised-controlled-trial',
    })).toBe('cohort-study')
  })

  it('a first-in-human device trial is a non-randomised clinical trial (UMPIRE)', () => {
    expect(kindOf({
      title:
        'The UMPIRE study: A first-in-human multicenter trial of bilateral subscalp monitoring for epileptic seizures',
      abstract:
        'Methods This prospective, multicenter first-in-human study enrolled adult patients with focal or generalized epilepsy.',
      keywords: ['Prospective Studies', 'Humans'],
      label: 'randomised-controlled-trial',
    })).toBe('clinical-trial')
  })

  it('a randomised trial protocol is a protocol (BREATHS)', () => {
    expect(kindOf({
      title:
        'Breathing control training as a treatment for functional seizures (BREATHS trial): a multicentre randomised controlled trial protocol',
      abstract: 'Methods and analysis A total of 220 participants (110 per group) are required.',
    })).toBe('protocol')
  })

  it('a commentary is a narrative review (six misconceptions)', () => {
    expect(kindOf({
      title: 'Epileptic Seizure Cycles: Six Common Clinical Misconceptions',
      label: 'systematic-review',
    })).toBe('narrative-review')
  })

  it('a nationwide survey is a survey (SEEG practice)', () => {
    expect(kindOf({
      title:
        'Stereoelectroencephalography for Epilepsy Presurgical Assessment: A Nationwide Survey of Evolution and Practice',
      abstract: 'We surveyed every Australian epilepsy surgery centre.',
    })).toBe('survey')
  })

  it('a genome-wide meta-analysis is a genetic association study, not a review', () => {
    expect(kindOf({
      title:
        'Genome-wide association study in a Chinese population identifies a susceptibility locus for type 2 diabetes at 7q32',
      abstract:
        'Methods We performed a meta-analysis of three GWAS comprising 684 patients and 955 controls.',
      label: 'randomised-controlled-trial',
    })).toBe('genetic-association-study')
  })

  it('a paper about placebo response across trials is a pooled analysis of trials', () => {
    expect(kindOf({
      title:
        'Factors associated with placebo response rate in randomized controlled trials of antiseizure medications',
      abstract:
        'Using individual-level data from 20 focal-onset seizure trials we evaluated participants randomized to placebo.',
      label: 'randomised-controlled-trial',
    })).toBe('pooled-analysis')
  })

  it('a historical-controlled study is a non-randomised trial, whatever dose it randomised (lacosamide monotherapy)', () => {
    expect(kindOf({
      title:
        'Conversion to lacosamide monotherapy in the treatment of focal epilepsy: results from a historical-controlled, multicenter, double-blind study',
      abstract:
        'Methods This historical-controlled, double-blind study enrolled patients aged 16-70 years. Patients were randomized to lacosamide 400 or 300 mg/day (3:1 ratio). The primary assessment was compared with the historical-control threshold (65.3%).',
      keywords: ['Historical Control', 'Humans'],
    })).toBe('clinical-trial')
  })

  it('a reporting checklist is a guideline, not a trial (GREENBEAN)', () => {
    expect(kindOf({
      title:
        'The GREENBEAN checklist for reporting studies evaluating the effectiveness of EEG-based biomarkers',
      abstract:
        'An international working group developed the Guidelines for Reporting EEG/Neurophysiology Biomarker Evaluation (GREENBEAN). EEG biomarker validation studies are classified into four phases, similarly to therapeutic studies. We provide a checklist of items to address and report.',
      keywords: ['Reporting Standard', 'Checklist', 'Research Design'],
    })).toBe('guideline')
    expect(studyDesignLabel('guideline')).toBe('Guideline or checklist')
  })

  it('a consensus statement is a guideline; a cohort about guideline adherence is a cohort', () => {
    expect(
      kindOf({ title: 'International consensus on diagnosis and management of Dravet syndrome' }),
    )
      .toBe('guideline')
    expect(kindOf({
      title:
        'International Consensus on the Evaluation and Management of Hypothalamic Hamartomas: Results From a Modified Delphi Survey',
      abstract: 'Methods A modified Delphi survey was conducted among 17 epilepsy surgery centers.',
    })).toBe('guideline')
    expect(kindOf({
      title: 'Adherence to status epilepticus guidelines: a retrospective cohort study',
    })).toBe('cohort-study')
  })

  it('a semi-structured interview used to score a phenotype is not a qualitative study', () => {
    expect(kindOf({
      title:
        'Tracing Autism Traits in Large Multiplex Families to Identify Endophenotypes of the Broader Autism Phenotype',
      abstract:
        'We evaluated ASD/BAP features using standardised tests and a semi-structured interview to assess social, intellectual, executive and adaptive functioning in 110 individuals.',
    })).toBeUndefined()
  })

  it('a modelling feasibility study is not a clinical trial', () => {
    expect(kindOf({
      title:
        'Using stereo-electroencephalography data to model the optimal intracranial venous sinus location for an endovascular seizure detection device: A feasibility study',
      abstract:
        'Objective We investigated the theoretical optimal venous location using SEEG data.',
      keywords: ['Feasibility Studies', 'Humans'],
    })).toBeUndefined()
  })

  it('an interview study inside a first-in-human trial is qualitative, not a trial (intelligent BCI)', () => {
    expect(kindOf({
      title: 'Embodiment and Estrangement: Results from a First-in-Human "Intelligent BCI" Trial',
      abstract:
        'We explored perceptions of self-change across six patients implanted with BCI devices. We used qualitative methodological tools grounded in phenomenology to conduct in-depth, semi-structured interviews.',
      keywords: ['Phenomenology', 'Qualitative Interviews'],
    })).toBe('qualitative-study')
    expect(studyDesignLabel('qualitative-study')).toBe('Qualitative study')
  })

  it('a randomised pilot trial that pools its own samples is the trial its title states (sodium selenate)', () => {
    expect(kindOf({
      title:
        "Supranutritional Sodium Selenate Supplementation Delivers Selenium to the Central Nervous System: Results from a Randomized Controlled Pilot Trial in Alzheimer's Disease",
      abstract:
        'A pilot study of 40 AD cases was randomized to placebo, nutritional, or supranutritional groups. Pooled analysis of all samples revealed that CSF selenium could predict change in MMSE performance.',
      keywords: ['Randomized controlled trial', 'Pilot Projects', 'Double-Blind Method'],
    })).toBe('randomised-controlled-trial')
  })

  it('a pilot trial without randomisation is a non-randomised clinical trial', () => {
    expect(kindOf({
      title: 'Sub-scalp EEG for seizure counting: a single-centre pilot trial',
      abstract: 'Ten adults with focal epilepsy were implanted and followed for six months.',
    })).toBe('clinical-trial')
  })

  it('a "pitfalls" paper is a narrative review, whatever it surveyed to write it (D3-18)', () => {
    // Loop 2 read the survey of centres as the design; the persona reads the
    // paper as the narrative it is, and the cases it collected as its examples.
    expect(kindOf({
      title: 'Pitfalls in genetic testing: the story of missed SCN1A mutations',
      abstract:
        'Methods We sent out a survey to 16 genetic centers performing SCN1A testing. Results We collected data on 28 mutations initially missed using Sanger sequencing.',
    })).toBe('narrative-review')
  })

  it('a phenotypic spectrum in N patients is a case series, not the case-control MeSH says (D3-18)', () => {
    expect(kindOf({
      title:
        'Spectrum of neurodevelopmental disease associated with the GNAO1 guanosine triphosphate-binding region',
      abstract:
        'This study examines the phenotypic spectrum associated with GNAO1 gene variants in 14 patients, focusing on epilepsy and movement disorders.',
      keywords: ['Movement Disorders', 'Mosaicism', 'Case-Control Studies', 'Child'],
    })).toBe('case-report')
  })

  it('sequencing thousands of cases is a cohort, not a case-control study (D3-18)', () => {
    expect(kindOf({
      title:
        'Large-scale targeted sequencing identifies risk genes for neurodevelopmental disorders',
      abstract:
        'This study investigates neurodevelopmental disorders (NDDs) by sequencing 125 candidate genes in over 16,000 cases. It identifies 48 genes with significant mutation burdens.',
      keywords: ['Humans', 'Case-Control Studies', 'Cohort Studies', 'DNA Mutational Analysis'],
    })).toBe('cohort-study')
    // The stored abstract: a "case-control mutation burden analysis" is the
    // statistic the cohort was put through, not the study's design.
    expect(kindOf({
      title:
        'Large-scale targeted sequencing identifies risk genes for neurodevelopmental disorders',
      abstract:
        'Most genes associated with neurodevelopmental disorders (NDDs) were identified with an excess of de novo mutations (DNMs) but the significance in case-control mutation burden analysis is unestablished. Here, we sequence 63 genes in 16,294 NDD cases and an additional 62 genes in 6,211 NDD cases.',
      keywords: ['Humans', 'Case-Control Studies', 'Cohort Studies', 'DNA Mutational Analysis'],
    })).toBe('cohort-study')
  })

  it("keeps a genetics paper's own case-control design", () => {
    expect(kindOf({
      title: 'Rare variants in drug-resistant focal epilepsy',
      abstract:
        'A case-control study comparing rare variant burden in 200 patients and 400 controls.',
    })).toBe('case-control-study')
  })

  it('an open-label extension is not the randomised trial it extended', () => {
    expect(kindOf({
      title:
        'Long-term open-label perampanel: Generalized tonic-clonic seizures in idiopathic generalized epilepsy',
      abstract:
        'Methods Patients previously enrolled in a randomized placebo-controlled trial of perampanel could enter an open-label extension phase.',
      label: 'randomised-controlled-trial',
    })).toBe('clinical-trial')
  })
})

describe('classifyStudyDesign - randomised controlled trials', () => {
  it('needs randomisation plus an arm to compare against', () => {
    expect(kindOf({
      title:
        'Adjunctive Transdermal Cannabidiol for Adults With Focal Epilepsy: A Randomized Clinical Trial',
    })).toBe('randomised-controlled-trial')
    expect(kindOf({
      title: 'Triheptanoin in glucose transporter deficiency',
      abstract: 'Patients were randomised 1:1 to triheptanoin or placebo in a double-blind design.',
    })).toBe('randomised-controlled-trial')
  })

  it('accepts the stored trial label only when the text mentions randomisation', () => {
    expect(classifyStudyDesign({
      title: 'Add-on therapy in refractory focal seizures',
      abstract: 'Participants were randomised to one of two doses.',
      label: 'randomised-controlled-trial',
    })).toEqual({ id: 'randomised-controlled-trial', stage: 'label' })
    expect(kindOf({
      title: 'Intracranial EEG fluctuates over months after implanting electrodes in human brain',
      abstract: 'Intracranial EEG from 15 patients was included in this study.',
      label: 'randomised-controlled-trial',
    })).toBeUndefined()
  })
})

describe('classifyStudyDesign - what never carries a design', () => {
  it('supplements and media', () => {
    expect(kindOf({ title: 'Supplementary material 1: A randomised trial', format: 'supplement' }))
      .toBeUndefined()
    expect(kindOf({ title: 'Video 1: A randomised trial', type: 'video' })).toBeUndefined()
    expect(kindOf({ title: 'Peer review history (2): A randomised trial protocol' }))
      .toBeUndefined()
  })

  it('a record that states no design, whatever the labeller said', () => {
    expect(kindOf({ title: 'Plasma proteome in LGI-1 autoimmune encephalitis' })).toBeUndefined()
    expect(kindOf({
      title: 'Seizure Forecasting Using a Novel Sub-Scalp Ultra-Long Term EEG Monitoring System',
      abstract: 'Five participants with refractory epilepsy used a sub-scalp device.',
      label: 'case-study',
    })).toBeUndefined()
  })
})

describe('classifyStudyDesign - other designs', () => {
  it('case reports and series', () => {
    expect(kindOf({ title: 'Impaired Color Recognition in HCN1 Epilepsy: A Single Case Report' }))
      .toBe('case-report')
    expect(kindOf({
      title: 'Hiding in Plain Sight: A case of post ictal psychosis with suicidal behavior',
    })).toBe('case-report')
    expect(kindOf({
      title: 'Neuronal ceroid lipofuscinosis type 2 in Australia',
      abstract: 'We describe a retrospective case series of eleven children.',
    })).toBe('case-report')
  })

  it('cross-sectional studies and systematic reviews', () => {
    expect(kindOf({
      title: 'Quality of life in adults with epilepsy',
      abstract: 'A cross-sectional study of 300 adults attending a tertiary clinic.',
    })).toBe('cross-sectional-study')
    expect(kindOf({
      title:
        'Second-line immunotherapy and functional outcomes in autoimmune encephalitis: A systematic review and meta-analysis',
    })).toBe('systematic-review')
  })

  it('a retrospective chart review is a cohort, not a narrative review', () => {
    expect(kindOf({
      title: 'Outcomes after temporal lobectomy: a retrospective review',
      abstract: 'A retrospective study of 120 consecutive patients.',
    })).toBe('cohort-study')
  })
})

describe('studyDesignLabel', () => {
  it('names every known design and title-cases the rest', () => {
    expect(studyDesignLabel('randomised-controlled-trial')).toBe('Randomised controlled trial')
    expect(studyDesignLabel('pooled-analysis')).toBe('Pooled analysis')
    expect(studyDesignLabel('report')).toBe('Report')
    expect(isStudyDesignId('cohort-study')).toBe(true)
    expect(isStudyDesignId('case-study')).toBe(false)
  })
})
