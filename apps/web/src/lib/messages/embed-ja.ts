/** Embedded assistant and its portal settings. Document and answer text remain verbatim. */
export const EMBED_JA: Readonly<Record<string, string>> = {
  'Answer': '回答',
  'Opens in a new tab': '新しいタブで開きます',
  'No cited answer was available. Try another question.':
    '出典付きの回答が見つかりませんでした。別の質問をお試しください。',
  'Research assistant': '研究アシスタント',
  'Ask a research question': '研究について質問する',
  'Search partner collections too': '連携先のコレクションも検索',
  'Searching the collections...': 'コレクションを検索しています...',
  'Answer ready. Sources follow the answer.': '回答ができました。回答の後に出典があります。',
  'Answers are grounded in the selected collections. Check the cited sources.':
    '選択したコレクションを根拠に回答します。引用された出典を確認してください。',
  'The answer could not be completed. Try again.':
    '回答を完了できませんでした。もう一度お試しください。',
  'Answer stopped.': '回答を停止しました。',
  'Some partner collections could not be searched.':
    '一部の連携先コレクションを検索できませんでした。',
  'Embedding is disabled for this portal.': 'このポータルの埋め込みは無効になっています。',
  'This portal requires sign-in.': 'このポータルにはサインインが必要です。',
  'Open the full portal in a new tab to sign in. Your browser may prevent sign-in inside an embedded frame.':
    '別のタブでポータルを開いてサインインしてください。ブラウザーの設定により、埋め込みフレーム内でサインインできない場合があります。',
  'Open full portal': 'ポータルを開く',
  'Embed the research assistant': '研究アシスタントを埋め込む',
  'Put this portal on your own website. Only the origins listed here may frame it.':
    '自分のウェブサイトにポータルを設置します。ここに登録したオリジンのみ埋め込みが許可されます。',
  'Enable embedding': '埋め込みを有効にする',
  'Allowed embedding origins': '埋め込みを許可するオリジン',
  'Enter up to 20 HTTPS origins, one per line, without paths or wildcards.':
    'HTTPS オリジンを1行に1つ、最大20件入力してください。パスとワイルドカードは使えません。',
  'Default view': '既定の表示',
  'Own collection only': '自分のコレクションのみ',
  'Own and partner collections': '自分と連携先のコレクション',
  'Partner search also requires agent ask to be enabled for this portal.':
    '連携先の検索には、このポータルのエージェント質問機能も有効にする必要があります。',
  'Private portals still require sign-in. Visitors can open the full portal in a new tab.':
    '非公開ポータルには引き続きサインインが必要です。利用者は別のタブでポータルを開けます。',
  'Save embedding settings': '埋め込み設定を保存',
  'Could not save embedding settings.': '埋め込み設定を保存できませんでした。',
  'Embedding settings saved.': '埋め込み設定を保存しました。',
  'Embed snippet': '埋め込みコード',
  'Use mode inline for a frame, or button for a dialog. View own hides partner search; federated offers it when available.':
    'フレームは inline、ダイアログは button を指定します。own は自分の資料のみ、federated は利用可能な連携先も検索します。',
}
