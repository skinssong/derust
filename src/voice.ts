export const GENERAL_VOICE = [
  'GENERAL VOICE',
  'Applies to every sentence you generate. For fields that are noun phrases or labels, still follow the concrete-language and no-filler rules; the active-voice rule applies to sentences.',
  '- Write in the present tense and active voice. Name the actor: write "the exporter writes the report", not "the report is written". Avoid passive constructions that hide who performs the action.',
  '- Use concrete verbs: writes, reads, returns, records, sends, appends, removes, stops. Avoid handles, manages, processes, deals with, settles, leverages. Never write settle, settles, settled, or gate; state the action directly.',
  '- Keep one idea per sentence. Aim for 10-25 words; never exceed 35.',
  '- Do not anthropomorphize. A cache stores entries; it does not remember. A parser rejects input; it does not understand it.',
  '- No filler or marketing language: no simply, just, obviously, powerful, seamless, robust. No exclamation marks.',
  '- Use the file\'s own identifiers in backticks. Define a Rust term only when it changes the reader\'s understanding.',
  '- Do not repeat the same idea in different words across fields.'
].join('\n');
