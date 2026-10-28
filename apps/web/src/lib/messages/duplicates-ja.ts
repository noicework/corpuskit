/** Duplicate review and collection comparison interface copy. */
export const DUPLICATES_JA: Readonly<Record<string, string>> = {
  'Same normalised title': '正規化したタイトルが一致',
  'Same origin URL after removing tracking parameters': '追跡パラメーターを除いた出典URLが一致',
  'Same source file name (file bytes have not been compared)':
    '元のファイル名が一致（ファイルのバイト列は未比較）',
  'Similar title and summary shingles ({score}%)': 'タイトルと要約の単語列が類似（{score}%）',
  'Different publication dates: possible versions': '公開日が異なるため、別バージョンの可能性あり',
  'Candidate pages': '候補のページ',
  'The CSV contains the current page of collection pairs.':
    'CSVには現在のページに表示されているコレクションの組が含まれます。',
  'Page {page} of {pages}': '{pages}ページ中{page}ページ',
  'Examples': '例',
  'Retire one': '一方を削除',
  'Refresh duplicate candidates': '重複候補を更新',
  'Duplicate candidates refreshed.': '重複候補を更新しました。',
  'Could not refresh duplicate candidates. Try again.':
    '重複候補を更新できませんでした。再試行してください。',
  'Review duplicate candidate': '重複候補を確認',
  'Review decision saved.': '確認結果を保存しました。',
  'Could not save the review decision. Try again.':
    '確認結果を保存できませんでした。再試行してください。',
  'Duplicates and versions': '重複とバージョン',
  'Metadata signals suggest pairs for human review. Scores are heuristics, not proof of identical content. Nothing is retired automatically.':
    'メタデータに基づく候補を人が確認します。スコアは目安であり、内容の一致を証明するものではありません。自動的に削除される資料はありません。',
  'To retire one, choose the document below and confirm its permanent deletion. Saved research keeps its cited passages.':
    '削除する場合は下の資料を選び、完全削除を確認してください。保存済みの調査には引用箇所が残ります。',
  'Refresh candidates': '候補を更新',
  'Updating duplicate review…': '重複確認を更新中…',
  'Could not load duplicate candidates. Try refreshing.':
    '重複候補を読み込めませんでした。更新してください。',
  'Loading duplicate candidates…': '重複候補を読み込み中…',
  'Resources checked': '確認した資料数',
  'Last computed': '最終計算日時',
  'This report reached its comparison limit. It shows part of the collection and may miss other matches.':
    '比較件数の上限に達しました。コレクションの一部のみが表示され、他の一致が見つからない場合があります。',
  'Show reviewed pairs': '確認済みの組を表示',
  'No unreviewed candidate pairs. Refresh after changing the collection.':
    '未確認の候補はありません。コレクションの変更後に更新してください。',
  'Evidence score': '一致の目安',
  'Keep both': '両方を保持',
  'Not a duplicate': '重複ではない',
  'Reviewed': '確認済み',
  'Retire this document': 'この資料を削除',
  'Document deleted after confirmation. Refreshing candidates.':
    '確認後に資料を削除しました。候補を更新しています。',
  'Download collection overlap': 'コレクションの重複状況をダウンロード',
  'Overlap CSV downloaded.': '重複状況のCSVをダウンロードしました。',
  'Refresh collection overlap': 'コレクションの重複状況を更新',
  'Overlap report refreshed.': '重複状況レポートを更新しました。',
  'Could not load the overlap report. Try again.':
    '重複状況レポートを読み込めませんでした。再試行してください。',
  'Collection overlap': 'コレクション間の重複',
  'Compare portal collections using listed metadata. Counts are resource pairs and categories can overlap. File contents have not been compared. Cached metadata expires after one day; refresh to recompute now.':
    '一覧のメタデータを使ってポータルのコレクションを比較します。件数は資料の組数で、区分間に重複があります。ファイルの内容は比較していません。メタデータのキャッシュは1日で期限切れになります。再計算するには更新してください。',
  'Refresh overlap': '重複状況を更新',
  'Download CSV': 'CSVをダウンロード',
  'Preparing overlap report…': '重複状況レポートを準備中…',
  'Loading overlap report…': '重複状況レポートを読み込み中…',
  'At least two portal collections are needed to compare overlap.':
    '重複状況を比較するには、少なくとも2つのポータルコレクションが必要です。',
  'Shared title pairs': 'タイトルが一致する組',
  'Shared URL pairs': 'URLが一致する組',
  'High similarity pairs': '類似度が高い組',
  'Matching pairs': '一致した組',
  'Comparison limit reached. Counts are lower bounds, not collection totals.':
    '比較件数の上限に達しました。件数は下限値であり、コレクション全体の合計ではありません。',
}
