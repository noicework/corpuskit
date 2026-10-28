/** Evaluation interface copy; questions and expected facts remain authored evidence. */
export const EVALUATIONS_JA: Readonly<Record<string, string>> = {
  'Evaluations': '評価',
  'Evaluation sets': '評価セット',
  'Evaluation set': '評価セット',
  'Evaluation definition': '評価内容',
  'New evaluation set': '新しい評価セット',
  'Measure this portal’s retrieval, citations, answer quality and declines over time.':
    'このポータルの検索、引用、回答品質、回答辞退を継続的に評価します。',
  'Each question uses up to one portal ask. Runs share the daily ask cap.':
    '各質問は最大1回の質問枠を使用します。評価にもポータルの1日の質問上限が適用されます。',
  'Today: {used} asks.': '本日の使用数: {used}回。',
  'Today: {used} of {cap} asks.': '本日の使用数: {used} / {cap}回。',
  'Working. A run can take several minutes.': '処理中です。評価には数分かかる場合があります。',
  'Evaluation data could not be loaded. Try refreshing the page.':
    '評価データを読み込めませんでした。ページを再読み込みしてください。',
  'Loading evaluation sets…': '評価セットを読み込み中…',
  'No evaluation sets yet. Define questions below to begin.':
    '評価セットはまだありません。以下で質問を設定してください。',
  'Set name': 'セット名',
  'Retrieval top k': '検索結果の評価対象件数',
  'Question {number}': '質問 {number}',
  'Should decline as unanswerable': '回答不能として辞退すべき質問',
  'Expected source resource IDs, separated by commas': '期待する出典の資料ID（カンマ区切り）',
  'Expected facts, one per line (optional)': '期待する事実（任意、1行に1件）',
  'Remove question {number}': '質問 {number}を削除',
  'Add question': '質問を追加',
  'Save evaluation set': '評価セットを保存',
  'Run the saved set: {count} asks. Save edits before running.':
    '保存済みセットを実行すると最大{count}回の質問枠を使用します。変更は実行前に保存してください。',
  'Run saved set': '保存済みセットを実行',
  'Confirm evaluation run': '評価の実行を確認',
  'This run will use up to {count} asks from this portal’s daily cap. Continue?':
    'この評価はポータルの1日の質問枠を最大{count}回使用します。続行しますか？',
  'Confirm {count} asks': '最大{count}回の使用を確認',
  'Cancel run': '実行をキャンセル',
  'Optional schedule': '定期実行（任意）',
  'Each scheduled run uses up to {count} asks from this portal’s daily cap. A current local administrator assignment is required. Editing the set pauses the schedule until it is confirmed again.':
    '定期評価は毎回、ポータルの1日の質問枠を最大{count}回使用します。有効なローカル管理者権限が必要です。内容を編集すると、再確認するまで定期実行が一時停止します。',
  'Repeat on the daily maintenance pass': '毎日のメンテナンス時に実行',
  'Weekly': '毎週',
  'Turn schedule off': '定期実行を停止',
  'Confirm schedule: up to {count} asks per run': '毎回最大{count}回の質問枠を使う定期実行を確認',
  'Next due: {date}.': '次回の実行予定: {date}。',
  'Definition changed. Confirm the schedule again to resume.':
    '評価内容が変更されています。再開するには定期実行を再確認してください。',
  'Run history': '実行履歴',
  'How scores are measured': '指標の測定方法',
  'Retrieval: any expected source in top k. Citation precision: distinct cited sources that are expected or verified by the ask path. Facts: literal phrase coverage, for reviewer guidance. REMi scores are returned by the ask path; missing scores remain unmeasured. Errors are reported separately.':
    '検索成功率は、期待する出典が上位の検索結果に含まれる割合です。引用精度は、引用した出典のうち、期待する出典または回答処理で検証済みの出典の割合です。事実の指標は、レビューを補助する文字列の一致率です。REMi指標には回答処理の結果を使用し、値がない指標は未測定とします。エラーは別に報告します。',
  'No runs yet.': '実行履歴はまだありません。',
  '{recorded} of {total} questions recorded. Errors: {errors}. Top k: {k}.':
    '記録済み: {recorded} / {total}問。エラー: {errors}件。検索対象: 上位{k}件。',
  'Retrieval hit rate': '検索成功率',
  'Citation precision': '引用精度',
  'Decline correctness': '回答辞退の正確性',
  'Expected fact coverage': '期待する事実の一致率',
  'REMi answer relevance': 'REMiの回答関連性',
  'REMi groundedness': 'REMiの根拠との整合性',
  'REMi context relevance': 'REMiの文脈関連性',
  'Previous run retrieval: {retrieval}; citation precision: {citations}. Compare the saved definitions when questions change.':
    '前回の検索成功率: {retrieval}、引用精度: {citations}。質問を変更した場合は、保存された評価内容も比較してください。',
  'Download CSV': 'CSVをダウンロード',
  'Per-question results': '質問ごとの結果',
  'Retrieval: {retrieval}; citations: {citations}; decline: {decline}.':
    '検索: {retrieval}、引用: {citations}、回答辞退: {decline}。',
  'Not measured': '未測定',
  'Not returned': '未取得',
  'not measured': '未測定',
  'hit': '成功',
  'miss': '不一致',
  'correct': '正しい',
  'incorrect': '誤り',
  'running': '実行中',
  'completed': '完了',
  'Evaluation set saved.': '評価セットを保存しました。',
  'Evaluation run finished. Review the results below.':
    '評価が終了しました。以下の結果を確認してください。',
  'Schedule turned off.': '定期実行を停止しました。',
  'Schedule confirmed. It runs on the next due maintenance pass.':
    '定期実行を確認しました。実行予定時刻以降のメンテナンス時に実行します。',
  'Evaluation CSV downloaded.': '評価のCSVをダウンロードしました。',
  'The evaluation could not be completed.': '評価を完了できませんでした。',
  'The CSV could not be downloaded.': 'CSVをダウンロードできませんでした。',
  'Evaluation request failed.': '評価のリクエストに失敗しました。',
  'The portal has too few asks remaining today for this run.':
    '本日の質問枠の残数がこの評価に必要な回数を下回っています。',
  'The saved set changed. Refresh it and confirm the current ask count.':
    '保存済みセットが変更されました。再読み込みして現在の質問回数を確認してください。',
  'An evaluation is already running on this portal. Try again after it finishes.':
    'このポータルでは評価を実行中です。終了後にもう一度お試しください。',
}
