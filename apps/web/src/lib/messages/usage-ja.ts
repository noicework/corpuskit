/** The monthly usage report's copy (Manage > Insights), including its column definitions. */
export const USAGE_JA: Readonly<Record<string, string>> = {
  'Monthly usage report': '月次利用レポート',
  "One month of questions, answers, ratings and documents added, by day in the portal's timezone. Download it as CSV, or open the report to read or print.":
    '1か月分の質問、回答、評価、追加された資料を、ポータルのタイムゾーンの日ごとにまとめます。CSVでダウンロードするか、レポートを開いて閲覧・印刷できます。',
  'Month': '月',
  '{month} (in progress)': '{month}（集計中）',
  'Download CSV': 'CSVをダウンロード',
  'Preparing CSV…': 'CSVを準備中…',
  'View report': 'レポートを表示',
  'Opening report…': 'レポートを開いています…',
  'Print report': 'レポートを印刷',
  'Read the usage report': '利用レポートを読み込む',
  'Download the usage report': '利用レポートをダウンロード',
  'Report for {month} ready below.': '{month}のレポートを下に表示しました。',
  'Downloaded {file}.': '{file}をダウンロードしました。',
  'Could not read the usage report.': '利用レポートを読み込めませんでした。',
  'Could not download the usage report.': '利用レポートをダウンロードできませんでした。',
  'Name a month as YYYY-MM, no later than this one, and a format of json or csv.':
    '月はYYYY-MM形式で今月以前を指定し、形式はjsonまたはcsvを指定してください。',
  '{portal}: {month}': '{portal}: {month}',
  '{from} to {through}, month in progress. Days are counted in {timezone}.':
    '{from}から{through}まで（集計中）。日付は{timezone}で数えています。',
  '{from} to {through}. Days are counted in {timezone}.':
    '{from}から{through}まで。日付は{timezone}で数えています。',
  'Generated {when}': '作成日時: {when}',
  'Date': '日付',
  'Questions': '質問',
  'Weakly grounded': '根拠が弱い回答',
  'Scored answers': 'スコア付きの回答',
  'Average groundedness': '根拠の充足度の平均',
  'Ratings': '評価',
  'Unhelpful ratings': '「役に立たない」の評価',
  'Documents added': '追加された資料',
  'Total': '合計',
  'No score': 'スコアなし',
  'Not held': 'データなし',
  '{share} of questions': '質問の{share}',
  'of {count} ratings': '評価{count}件中',
  'Usage by day': '日別の利用状況',
  'Usage by day for {month}, with the month total last':
    '{month}の日別の利用状況（最後の行は月の合計）',
  'What each column counts': '各列の内容',
  'Topics of unanswered questions are not recorded, and the questions themselves are left out because they can hold personal data. Curators can read them under Knowledge gaps in Insights.':
    '未回答の質問のトピックは記録されません。質問文には個人情報が含まれる場合があるため、このレポートには含めていません。資料管理者は利用状況の「不足している資料分野」で質問を確認できます。',
  'The ask log no longer holds the questions from this month, so their counts are blank.':
    '質問ログにこの月の質問が残っていないため、質問の件数は空欄です。',
  'The ask log no longer holds questions from before {date}, so earlier days are blank.':
    '質問ログには{date}より前の質問が残っていないため、それ以前の日は空欄です。',
  'Ratings are kept for {days} days, and at most {kept} per portal, so this month has no rating counts.':
    '評価は{days}日間、ポータルごとに最大{kept}件まで保持されるため、この月の評価件数はありません。',
  'Ratings are kept for {days} days, and at most {kept} per portal, so days before {date} have no rating counts.':
    '評価は{days}日間、ポータルごとに最大{kept}件まで保持されるため、{date}より前の日の評価件数はありません。',
  'The knowledge box could not be read, so documents added is blank.':
    'ナレッジボックスを読み込めなかったため、追加された資料は空欄です。',
  'The knowledge box could not be read back to this month, so documents added is blank.':
    'ナレッジボックスをこの月まで遡って読み込めなかったため、追加された資料は空欄です。',
  'The knowledge box was read back to {date} only, so earlier days have no count.':
    'ナレッジボックスは{date}までしか遡って読み込めなかったため、それ以前の日の件数はありません。',
  'Totals add up the days that are held.': '合計は、データが保持されている日だけを集計しています。',
  // Column definitions, shared with the CSV export (packages/core/src/usage-report.ts).
  "The calendar day in the portal's timezone as YYYY-MM-DD; the row named total covers the whole month":
    'ポータルのタイムゾーンでの日付（YYYY-MM-DD）。totalの行は月全体です',
  "Research questions asked in the portal's assistant that day; a question asked across several portals counts in each portal it searched; help questions are not counted":
    'その日にポータルのアシスタントで尋ねられた研究に関する質問。複数のポータルにまたがる質問は、検索した各ポータルで数えます。ヘルプへの質問は数えません',
  'Questions answered with at least one cited source': '1件以上の引用元を示して回答した質問',
  'Questions the collection could not answer: declined or failed answers and answers without a cited source':
    '資料から回答できなかった質問。回答を断ったもの、失敗したもの、引用元のない回答を含みます',
  'Answered questions with a groundedness score of 2 or less out of 5':
    '根拠の充足度が5段階中2以下だった回答済みの質問',
  'Unanswered plus weakly grounded questions; the questions Insights lists as knowledge gaps':
    '未回答の質問と根拠が弱い回答の合計。利用状況で「不足している資料分野」として表示される質問です',
  'Answered questions that received a groundedness score': '根拠の充足度が算出された回答済みの質問',
  'The mean groundedness score of scored answers from 0 to 5 to one decimal place; it measures how well the cited passages support each answer; blank when no answer was scored':
    'スコア付きの回答の根拠の充足度の平均（0から5、小数点以下1桁）。引用した箇所が各回答をどれだけ裏付けているかを示します。スコア付きの回答がない場合は空欄です',
  "Readers' helpful and unhelpful ratings received that day for answers this portal gave":
    'このポータルの回答に対して、その日に読者から寄せられた「役に立った」「役に立たない」の評価',
  'Ratings received that day that marked an answer unhelpful':
    'その日に寄せられた評価のうち、回答を「役に立たない」としたもの',
  'Library documents added that day that the knowledge box still holds; drafts and help pages and failed imports are not counted':
    'その日に追加され、現在もナレッジボックスにあるライブラリの資料。下書き、ヘルプページ、取り込みに失敗したものは数えません',
}
