/** Agent ask interface copy (docs/AGENT-ASK.md). Passages, titles and reasons from the agent are never translated here. */
export const AGENT_JA: Readonly<Record<string, string>> = {
  'Agent ask': 'エージェントに質問',
  'Ask across the collections': 'コレクションを横断して質問',
  "Ask a question across all of this portal's collections. An answer can take up to two minutes.":
    'このポータルのすべてのコレクションに質問します。回答には最長2分ほどかかります。',
  'Enter to send · Shift+Enter for a new line · up to 2,000 characters':
    'Enterで送信 · Shift＋Enterで改行 · 2,000文字まで',
  'Portals to include': '含めるポータル',
  'this portal': 'このポータル',
  'Each organisation decides whether its portal takes part, so a portal selected here may be left out. The collections searched show which took part.':
    '参加するかどうかは各組織が決めるため、ここで選んだポータルが含まれないことがあります。検索した研究コレクションに、参加したポータルが示されます。',
  'Try a question': '質問を試す',
  'Steps and collections searched': 'ステップと検索したコレクション',
  'No answer arrived within five minutes, so the page stopped waiting. The steps and passages found so far are kept. Try again, or ask a narrower question.':
    '5分以内に回答が届かなかったため、待機を終了しました。これまでのステップと本文はそのまま残ります。もう一度試すか、質問を絞ってください。',
  "The portal could not start this answer. Try again in a moment, or use Ask for this portal's collection.":
    'ポータルはこの回答を開始できませんでした。しばらくしてからもう一度試すか、「質問」でこのポータルのコレクションに質問してください。',
  'The connection closed before the answer finished. What arrived is kept on this page. Try again in a moment.':
    '回答が完了する前に接続が切れました。届いた内容はこのページに残ります。しばらくしてからもう一度お試しください。',
  "Agent ask is not set up on this portal. Use Ask to put your question to this portal's collection.":
    'このポータルではエージェントへの質問が設定されていません。「質問」でこのポータルのコレクションに質問してください。',
  '{label} could not be searched. The answer uses the other collections.':
    '{label}を検索できませんでした。回答は他のコレクションから作られています。',
  '{count} collections could not be searched. The answer uses the others.':
    '{count}件のコレクションを検索できませんでした。回答は他のコレクションから作られています。',
  'Finished. No direct evidence found in the collections searched.':
    '完了しました。検索したコレクションに直接の根拠は見つかりませんでした。',
  'Answer finished: 1 citation from 1 collection.':
    '回答が完成しました。1件のコレクションから1件を引用しています。',
  'Answer finished: {citations} citations from 1 collection.':
    '回答が完成しました。1件のコレクションから{citations}件を引用しています。',
  'Answer finished: {citations} citations from {collections} collections.':
    '回答が完成しました。{collections}件のコレクションから{citations}件を引用しています。',
  'Stopped. The steps and passages found so far are kept.':
    '停止しました。これまでのステップと本文はそのまま残ります。',
  // The step timeline
  'Steps': 'ステップ',
  '{done} of about {total} done': '約{total}件中{done}件が完了',
  '1 step': 'ステップ1件',
  '{count} steps': 'ステップ{count}件',
  'Waiting for the first step.': '最初のステップを待っています。',
  'Each step appears here as the portal works on your question.':
    'ポータルが質問に取り組むにつれて、各ステップがここに表示されます。',
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
  'Research collections searched': '検索した研究コレクション',
  'Passages from {found} of {total}': '{total}件中{found}件から本文',
  'Waiting for the list of collections to search.': '検索するコレクションの一覧を待っています。',
  'Each collection searched appears here with the passages it returned.':
    '検索した各コレクションと、返された本文がここに表示されます。',
  'federated partner': '連携パートナー',
  'partner over MCP': 'MCP経由のパートナー',
  'Untitled passage': '無題の本文',
  'Open in the Library': 'ライブラリで開く',
  'Open the document': '資料を開く',
  'Timed out': 'タイムアウト',
  'Not reached': '接続できません',
  '1 passage': '本文1件',
  '{count} passages': '本文{count}件',
  'Not searched yet': 'まだ検索していません',
  'Not searched': '検索していません',
  'No passages found': '本文は見つかりませんでした',
  'Did not answer in time.': '時間内に応答がありませんでした。',
  'This partner could not be reached.': 'このパートナーに接続できませんでした。',
  'Could not be searched.': '検索できませんでした。',
  // The answer card
  'Answer': '回答',
  'Cited answer': '出典付きの回答',
  "Answered by the portal's research agent": 'ポータルのリサーチエージェントが回答',
  'Composed by CorpusKit from 1 collection': 'CorpusKitが1件のコレクションから構成',
  'Composed by CorpusKit from {count} collections': 'CorpusKitが{count}件のコレクションから構成',
  'Elapsed': '経過時間',
  'Answered in {duration}': '{duration}で回答',
  'did not answer in time.': 'は時間内に応答しませんでした。',
  'could not be reached.': 'に接続できませんでした。',
  'could not be searched.': 'を検索できませんでした。',
  'The answer uses the collections that responded, so it may leave out research held only in {label}.':
    '回答は応答したコレクションから作られているため、{label}だけにある研究が含まれていない可能性があります。',
  'The answer uses the collections that responded, so it may leave out research held only in those collections.':
    '回答は応答したコレクションから作られているため、それらのコレクションだけにある研究が含まれていない可能性があります。',
  'Connecting': '接続中',
  'Citation arriving': '出典を受信中',
  'Source {index}': '資料{index}',
  "Shown without a link to the partner's document": 'パートナーの資料へのリンクなしで表示',
  'This answer has no citations. Check the passages under the collections searched before relying on it.':
    'この回答には引用がありません。利用する前に、検索した研究コレクションの本文を確認してください。',
  'The collections searched do not support an answer to this question. Try a question closer to what they cover.':
    '検索したコレクションでは、この質問への回答を裏付けられません。コレクションの内容に近い質問をお試しください。',
  'No answer in time': '時間内に回答がありません',
  'Agent ask is not set up on this portal':
    'このポータルではエージェントへの質問が設定されていません',
  'The answer was stopped': '回答が停止されました',
  'The answer could not be finished': '回答を完了できませんでした',
  'The text above arrived before the answer stopped and may be incomplete. Check its citations before relying on it.':
    '上の本文は回答が停止する前に届いたもので、不完全な場合があります。利用する前に引用を確認してください。',
  'Stopped': '停止しました',
  'The text above arrived before you stopped the answer and may be incomplete. Check its citations before relying on it.':
    '上の本文は回答を停止する前に届いたもので、不完全な場合があります。利用する前に引用を確認してください。',
  'The steps and passages found so far are kept.': 'これまでのステップと本文はそのまま残ります。',
  'working': '作業内容',
  '1 note': 'メモ1件',
  '{count} notes': 'メモ{count}件',
  '1 citation': '引用1件',
}
