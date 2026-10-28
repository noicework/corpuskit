export const ANSWER_POLICY_JA: Readonly<Record<string, string>> = {
  'Additional answer instructions': '回答への追加指示',
  'Appended after built-in grounding instructions for Ask, search answers and composed agent answers on this portal. They cannot remove grounding or citation checks. Leave empty for the built-in instructions only.':
    'このポータルの質問、検索回答、エージェントの統合回答で、標準の根拠指示の後に追加されます。根拠や引用の確認は解除できません。空欄の場合は標準の指示のみを使用します。',
  'For example: explain specialist terms and end with a short practical summary.':
    '例：専門用語を説明し、最後に実用的な要約を添えてください。',
  '{count} / 2000 characters. Plain text only. Built-in evidence and citation rules always apply.':
    '{count} / 2000 文字。プレーンテキストのみ。標準の根拠と引用の規則は常に適用されます。',
  'Reset answer instructions': '回答指示をリセット',
  'Default settings restored. Save to apply.': '標準設定に戻しました。保存すると適用されます。',
  'Answer guardrails': '回答の制限',
  'Only this portal is affected. Topics and terms are literal phrases, not regular expressions. Use one per line, up to 50 phrases of 120 characters each. Matching ignores case, character width and repeated spaces. Latin phrases match whole words; Japanese phrases match within text.':
    'このポータルだけに適用されます。話題と語句は正規表現ではなく、そのままの語句です。1行に1件、各120文字以内で最大50件。大文字と小文字、全角と半角、連続する空白は区別しません。英数字は単語単位、日本語は部分一致で照合します。',
  'Out-of-scope topics': '対象外の話題',
  'Matching questions are refused before any answer is generated.':
    '一致した質問は、回答を生成する前に拒否します。',
  'Blocked terms in answers': '回答内の禁止語句',
  'If an answer contains one of these phrases, the whole answer is withheld.':
    '回答にいずれかの語句が含まれる場合、回答全体を非表示にします。',
  'Question refusal message': '質問を拒否する際のメッセージ',
  'Withheld answer message': '回答を非表示にする際のメッセージ',
  'Portal contact line': 'ポータルの連絡先',
  'Plain text added to both messages, such as a team email address. Up to 240 characters.':
    '両方のメッセージに追加するプレーンテキストです。チームのメールアドレスなど、240文字以内で入力してください。',
  'Maximum answer length': '回答の最大文字数',
  '100 to 20,000 characters, including spaces and citation markers. Leave empty for no portal cap. Longer answers are withheld whole to preserve citation accuracy. Policy messages are exempt.':
    '空白と引用番号を含めて100～20,000文字。空欄の場合、ポータル独自の上限はありません。引用の正確性を保つため、上限を超える回答は全体を非表示にします。制限を知らせるメッセージは対象外です。',
  'With answer checks enabled, text waits until the full answer has been checked. Refused questions and withheld answers are counted in Insights.':
    '回答の確認を有効にすると、回答全体の確認が終わるまで本文を表示しません。拒否した質問と非表示にした回答の件数は分析に記録されます。',
  'Reset guardrails': '回答制限をリセット',
  'Save answer settings': '回答設定を保存',
  'Check the instruction, phrase, message and length limits before saving.':
    '保存する前に、指示、語句、メッセージ、回答文字数の制限を確認してください。',
  'Questions refused by policy': '設定により拒否された質問',
  'Answers withheld for blocked terms': '禁止語句により非表示にした回答',
  'Answers withheld for length': '文字数により非表示にした回答',
}
