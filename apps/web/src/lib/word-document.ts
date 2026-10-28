import { escapeHtml } from './answer-export.ts'

/**
 * The Word-compatible document shell every export shares: a self-contained
 * HTML page with the Word-namespaced head, saved as `.doc`, which Word (and
 * Pages, and LibreOffice) opens as a formatted document. The body is the
 * caller's HTML, already escaped.
 */
export function wordDocumentHtml(title: string, bodyHtml: string): string {
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<!--[if gte mso 9]>
<xml>
<w:WordDocument>
<w:View>Print</w:View>
<w:Zoom>100</w:Zoom>
<w:DoNotOptimizeForBrowser/>
</w:WordDocument>
</xml>
<![endif]-->
<style>
body { font-family: Georgia, 'Times New Roman', serif; color: #1a1a1a; line-height: 1.5; }
h1, h2, h3, h4 { font-family: Arial, Helvetica, sans-serif; color: #111111; }
h1 { font-size: 20pt; margin-bottom: 4pt; }
h2 { font-size: 13pt; margin-top: 18pt; margin-bottom: 6pt; }
h3 { font-size: 11.5pt; margin-top: 12pt; margin-bottom: 4pt; }
h4 { font-size: 11pt; margin-top: 10pt; margin-bottom: 4pt; }
p, li { margin: 6pt 0; font-size: 11pt; }
ol, ul { margin: 6pt 0 6pt 18pt; }
table { border-collapse: collapse; margin: 8pt 0; }
th, td { border: 1px solid #999999; padding: 3pt 6pt; font-size: 10.5pt; vertical-align: top; }
blockquote { margin: 6pt 0 6pt 12pt; color: #444444; }
sup { font-size: 8pt; }
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`
}

/** A file-name stem from a title: lower-case words joined by hyphens, else today's date. */
export function slugOrDate(title: string, now: Date = new Date()): string {
  const slug = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '')
  return slug.length > 0 ? slug.slice(0, 60) : now.toISOString().slice(0, 10)
}
