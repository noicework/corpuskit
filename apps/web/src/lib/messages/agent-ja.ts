/** Agent ask interface copy (docs/AGENT-ASK.md). Passages, titles and reasons from the agent are never translated here. */
export const AGENT_JA: Readonly<Record<string, string>> = {
  'Agent ask': 'エージェントに質問',
  'Ask across the collections': 'コレクションを横断して質問',
  'One question, searched through every collection it may draw on. Watch each step, see what every collection returned, then read a cited answer. An answer takes one to two minutes.':
    'ひとつの質問を、参照できるすべてのコレクションで検索します。各ステップと、各コレクションが返した結果を確認し、出典付きの回答を読めます。回答には1〜2分かかります。',
  'Ask one question across every collection': 'すべてのコレクションに対してひとつの質問をする',
  'Enter sends; Shift+Enter starts a new line. Up to 2,000 characters.':
    'Enterで送信、Shift+Enterで改行します。2,000文字まで。',
  'Ask the agent': 'エージェントに質問する',
  'Collections to search': '検索するコレクション',
  'this portal': 'このポータル',
  "Each collection's owner decides whether it takes part. The answer lists which did.":
    '参加するかどうかは各コレクションの所有者が決めます。回答には参加したコレクションが示されます。',
  'Try a question': '質問を試す',
  'How is a warmer climate changing pest and disease pressure?':
    '温暖化は病害虫の圧力をどう変えていますか？',
  'What triggers movement controls between growing areas?':
    '生産地域間の移動規制は何をきっかけに発動されますか？',
  'Which management changes does the research recommend for hot seasons?':
    '暑い季節に向けて、研究はどのような管理の変更を推奨していますか？',
  'The steps and the passages each collection returns appear beside the answer as it is made, so you can see where every claim came from.':
    '回答が作られる間、各ステップと各コレクションが返した本文が回答の横に表示され、すべての記述の出どころを確認できます。',
  'How this answer is being made': 'この回答の作られ方',
  'No answer arrived within five minutes, so the page stopped waiting.':
    '5分以内に回答が届かなかったため、待機を終了しました。',
  'The agent is unavailable - please try again.':
    'エージェントを利用できません。もう一度お試しください。',
  'This portal does not offer agent ask.':
    'このポータルではエージェントへの質問を提供していません。',
  '{label} could not be searched; the answer comes from the rest.':
    '{label}を検索できませんでした。回答は残りのコレクションから作られます。',
  '{count} collections could not be searched; the answer comes from the rest.':
    '{count}件のコレクションを検索できませんでした。回答は残りのコレクションから作られます。',
  'Answer complete: {citations} citations across {collections} collections.':
    '回答が完成しました。{collections}件のコレクションから{citations}件を引用しています。',
  'Stopped. Everything that had arrived is kept.': '停止しました。届いた内容はそのまま残ります。',
  // The step timeline
  'Steps': 'ステップ',
  '{done} of {total} done': '{total}件中{done}件が完了',
  'Waiting for the first step.': '最初のステップを待っています。',
  'Each step appears here as the agent works.':
    'エージェントの作業に合わせて、各ステップがここに表示されます。',
  'Preparing': '準備',
  'Searching': '検索',
  'Summarising': '要約',
  'Checking': '確認',
  'Writing': '執筆',
  '(failed)': '（失敗）',
  '(running)': '（実行中）',
  '{seconds} s': '{seconds}秒',
  'min': '分',
  // The collections
  'Collections': 'コレクション',
  '{found} of {total} returned passages': '{total}件中{found}件が本文を返しました',
  'Waiting to hear which collections will be searched.':
    'どのコレクションを検索するかを待っています。',
  'Each collection searched appears here with the passages it returned.':
    '検索した各コレクションと、返された本文がここに表示されます。',
  'federated partner': '連携パートナー',
  'partner over MCP': 'MCP経由のパートナー',
  'Asked': '質問',
  'Untitled passage': '無題の本文',
  'Timed out': 'タイムアウト',
  'Not reached': '接続できません',
  '1 passage': '本文1件',
  '{count} passages': '本文{count}件',
  'Queued': '待機中',
  'No passages': '本文なし',
  'Did not answer within the time limit.': '制限時間内に応答がありませんでした。',
  'This partner could not be reached.': 'このパートナーに接続できませんでした。',
  'Could not be searched.': '検索できませんでした。',
  // The answer card
  'Answer': '回答',
  'Retrieval agent': '検索エージェント',
  'Composed by CorpusKit from 1 collection': 'CorpusKitが1件のコレクションから構成',
  'Composed by CorpusKit across {count} collections':
    'CorpusKitが{count}件のコレクションを横断して構成',
  'Elapsed': '経過時間',
  'Answered in {duration}': '{duration}で回答',
  'The answer draws on the one remaining collection.':
    '回答は残る1件のコレクションから作られています。',
  'The answer draws on the other {count} collections.':
    '回答は残る{count}件のコレクションから作られています。',
  'Connecting': '接続中',
  'Citation arriving': '出典を受信中',
  'Source {index}': '資料{index}',
  'This partner does not link to its documents': 'このパートナーは資料へのリンクを提供していません',
  'The agent finished without an answer': 'エージェントは回答を出さずに終了しました',
  'Nothing it found supported an answer. Try a question closer to what the collections cover.':
    '見つかった内容では回答を裏付けられませんでした。コレクションの内容に近い質問をお試しください。',
  'No answer in time': '時間内に回答がありません',
  'This portal has no agent': 'このポータルにはエージェントがありません',
  'The agent stopped': 'エージェントが停止しました',
  'The agent could not finish': 'エージェントは完了できませんでした',
  'The text above is what arrived before it stopped; it may be incomplete.':
    '上の本文は停止前に届いた内容で、不完全な場合があります。',
  'Stopped': '停止しました',
  'The text above is what arrived before you stopped it; it may be incomplete.':
    '上の本文は停止前に届いた内容で、不完全な場合があります。',
  'Everything that had arrived is kept.': '届いた内容はそのまま残ります。',
  'reasoning': '推論',
  '1 note': 'メモ1件',
  '{count} notes': 'メモ{count}件',
  '1 citation': '引用1件',
}
