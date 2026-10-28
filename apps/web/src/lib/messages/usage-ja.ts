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
  // Response times, and Insights' knowledge gaps for the month.
  'Response times': '応答時間',
  "Percentiles over the month's answered questions. The portal server measures time to first token and answer time from receiving each question; answers from before it measured them have none. Generation time is the knowledge box's own report. Search response times are not measured.":
    'この月の回答済みの質問を対象としたパーセンタイルです。最初のトークンまでの時間と回答時間は、ポータルのサーバーが各質問を受け取った時点から測定しています。測定を始める前の回答にはありません。生成時間はナレッジボックス自身の報告です。検索の応答時間は測定していません。',
  'Response times for {month}': '{month}の応答時間',
  'Measure': '項目',
  'Answers timed': '測定した回答',
  'Time to first token': '最初のトークンまでの時間',
  'Answer time': '回答時間',
  'Generation time (knowledge box)': '生成時間（ナレッジボックス）',
  'Not measured': '測定なし',
  'Timed answers': '時間を測定した回答',
  'Time to first token p50': '最初のトークンまでの時間 p50',
  'Time to first token p90': '最初のトークンまでの時間 p90',
  'Time to first token p95': '最初のトークンまでの時間 p95',
  'Answer time p50': '回答時間 p50',
  'Answer time p90': '回答時間 p90',
  'Answer time p95': '回答時間 p95',
  'Generation timed': '生成時間のある回答',
  'Generation time p50': '生成時間 p50',
  'Generation time p90': '生成時間 p90',
  'Generation time p95': '生成時間 p95',
  'Answered questions whose response times the portal server measured; it has measured them since the release that added these columns':
    'ポータルのサーバーが応答時間を測定した回答済みの質問。これらの列を追加したリリース以降に測定しています',
  'Median seconds from the portal server receiving a question to sending the first words of its answer; over timed answers':
    'ポータルのサーバーが質問を受け取ってから回答の最初の文字を送るまでの秒数の中央値。時間を測定した回答が対象です',
  'The 90th percentile of the time to first token in seconds':
    '最初のトークンまでの時間（秒）の90パーセンタイル',
  'The 95th percentile of the time to first token in seconds':
    '最初のトークンまでの時間（秒）の95パーセンタイル',
  'Median seconds from the portal server receiving a question to finishing its answer; over timed answers':
    'ポータルのサーバーが質問を受け取ってから回答を終えるまでの秒数の中央値。時間を測定した回答が対象です',
  'The 90th percentile of the answer time in seconds': '回答時間（秒）の90パーセンタイル',
  'The 95th percentile of the answer time in seconds': '回答時間（秒）の95パーセンタイル',
  'Answered questions with a generation time reported by the knowledge box':
    'ナレッジボックスが生成時間を報告した回答済みの質問',
  "Median seconds the knowledge box reports spending to generate an answer; it leaves out the portal's own routing and checks and the network to the reader":
    'ナレッジボックスが報告する回答の生成にかかった秒数の中央値。ポータル自体の振り分けや確認と読者までの通信時間は含みません',
  'The 90th percentile of the generation time in seconds': '生成時間（秒）の90パーセンタイル',
  'The 95th percentile of the generation time in seconds': '生成時間（秒）の95パーセンタイル',
  'Top knowledge gaps in {month}': '{month}に多かった不足している資料分野',
  'The questions asked most this month that the collection could not answer, or answered on weak grounding. Questions can hold personal data, so they are shortened, shown only to curators and administrators, and never exported.':
    '今月多く尋ねられた質問のうち、資料から回答できなかったもの、または根拠が弱い回答となったものです。質問には個人情報が含まれる場合があるため、短縮して資料管理者と管理者にのみ表示し、エクスポートには含めません。',
  'No knowledge gaps this month.': '今月は不足している資料分野はありません。',
  '{count} unanswered': '未回答{count}件',
  '{count} weakly grounded': '根拠が弱い回答{count}件',
  'Evidence coverage by topic': 'トピック別の根拠の網羅状況',
  "Not available: the ask log keeps each question's text but not its topic, and an unanswered question has no cited source to take a topic from.":
    '利用できません。質問ログには質問文は残りますがトピックは記録されず、未回答の質問にはトピックを判断できる引用元もありません。',
}
