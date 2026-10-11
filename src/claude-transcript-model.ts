/**
 * @fileoverview The model a claude session last answered with, read off its JSONL
 * transcript, for a remote claude that has no statusline exporter reporting back.
 *
 * Every assistant record carries `message.model` (`claude-sonnet-5`, `claude-opus-5-5`),
 * the model that actually produced it, so it follows an in-session `/model` from the
 * next answer on. Records claude writes itself (`<synthetic>`, an API error stand-in)
 * name no model and are skipped.
 *
 * Tests: `test/claude-transcript-model.test.ts`.
 *
 * @module claude-transcript-model
 */

/**
 * The model of the newest assistant record in a transcript tail, or undefined.
 *
 * @param tail the end of a `.jsonl` transcript; its first line may be cut mid-record
 *   (a byte tail) and is then skipped like any line that does not parse.
 */
export function lastAssistantModel(tail: string): string | undefined {
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.includes('"assistant"')) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const { type, message } = record as { type?: unknown; message?: { model?: unknown } };
    if (type !== 'assistant') continue;
    const model = message?.model;
    if (typeof model === 'string' && model && !model.startsWith('<')) return model;
  }
  return undefined;
}

/**
 * A model id as the statusline names it: `claude-sonnet-5` → `Sonnet 5`,
 * `claude-opus-5-5-20260101` → `Opus 5.5`. Anything else is returned unchanged.
 */
export function friendlyClaudeModel(id: string): string {
  const m = /^claude-([a-z]+)-(\d+(?:-\d{1,2})*)(?:-\d{8})?$/i.exec(id);
  if (!m) return id;
  return `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} ${m[2].replace(/-/g, '.')}`;
}
