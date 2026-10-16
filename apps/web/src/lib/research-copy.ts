import { type MessageValues, portalUi } from './locale-messages.ts'

/** For application-owned copy in pure render/export helpers. Never pass authored evidence. */
export type ResearchUi = (english: string, values?: MessageValues) => string
export const englishResearchUi: ResearchUi = (english, values) => portalUi('en', english, values)
