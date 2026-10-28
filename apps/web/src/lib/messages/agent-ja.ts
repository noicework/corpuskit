/** Agent ask interface copy (docs/AGENT-ASK.md). Passages, titles and reasons from the agent are never translated here. */
export const AGENT_JA: Readonly<Record<string, string>> = {
  'Agent ask': 'エージェントに質問',
  'Ask across the collections': 'コレクションを横断して質問',
  'Ask a question across every collection this portal can search. Each step, and what each collection returned, is shown while the answer is written. Answers take one to two minutes.':
    'このポータルが検索できるすべてのコレクションに質問します。各ステップと、各コレクションが返した内容は、回答が書かれる間に表示されます。回答には1〜2分かかります。',
  'Ask one question across every collection': 'すべてのコレクションに対してひとつの質問をする',
  'Enter sends; Shift+Enter starts a new line. Up to 2,000 characters.':
    'Enterで送信、Shift+Enterで改行します。2,000文字まで。',
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
  'How this answer is being made': 'この回答の作られ方',
  'No answer arrived within five minutes, so the page stopped waiting.':
    '5分以内に回答が届かなかったため、待機を終了しました。',
  '{label} could not be searched; the answer comes from the rest.':
    '{label}を検索できませんでした。回答は残りのコレクションから作られます。',
  '{count} collections could not be searched; the answer comes from the rest.':
    '{count}件のコレクションを検索できませんでした。回答は残りのコレクションから作られます。',
  'Answer complete: {citations} citations across {collections} collections.':
    '回答が完成しました。{collections}件のコレクションから{citations}件を引用しています。',
  'Stopped. Everything that had arrived is kept.': '停止しました。届いた内容はそのまま残ります。',
  'The portal could not start the answer. Try again in a moment.':
    'ポータルは回答を開始できませんでした。しばらくしてからもう一度お試しください。',
  'Agent ask is not set up on this portal.':
    'このポータルではエージェントへの質問が設定されていません。',
  // The step timeline
  'Each step appears here as the answer is made.':
    '回答が作られるにつれて、各ステップがここに表示されます。',
  'Steps': 'ステップ',
  '{done} of {total} done': '{total}件中{done}件が完了',
  'Waiting for the first step.': '最初のステップを待っています。',
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
  'Collections searched': '検索したコレクション',
  'Waiting for the list of collections to search.': '検索するコレクションの一覧を待っています。',
  'Open in the Library': 'ライブラリで開く',
  '{found} of {total} returned passages': '{total}件中{found}件が本文を返しました',
  'Each collection searched appears here with the passages it returned.':
    '検索した各コレクションと、返された本文がここに表示されます。',
  'federated partner': '連携パートナー',
  'partner over MCP': 'MCP経由のパートナー',
  'Asked': '質問',
  'Untitled passage': '無題の本文',
  'Open the document': '資料を開く',
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
  'Cited answer': '出典付きの回答',
  'Research agent': 'リサーチエージェント',
  'The collections searched do not support an answer to this question. Try a question closer to what they cover.':
    '検索したコレクションでは、この質問への回答を裏付けられません。コレクションの内容に近い質問をお試しください。',
  'Agent ask is not set up on this portal':
    'このポータルではエージェントへの質問が設定されていません',
  'The answer was stopped': '回答が停止されました',
  'The answer could not be finished': '回答を完了できませんでした',
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
  'No answer in time': '時間内に回答がありません',
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
