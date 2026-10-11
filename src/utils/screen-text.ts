/**
 * @fileoverview The rendered pane text `agent read --tail` prints.
 *
 * The raw terminal buffer is a byte stream: a TUI like Claude Code positions
 * its rows with cursor moves, so stripping the escapes leaves one long line,
 * and a byte cut can land inside an escape and leave its tail behind
 * (`8;5;246m`). A plain `capture-pane -p -J -S -N` is the screen as tmux drew
 * it, one line per row. This module only trims that text to a byte budget.
 *
 * @module utils/screen-text
 */

/** Default byte budget when the caller names none (matches the CLI's `--tail` default). */
export const DEFAULT_SCREEN_TAIL_BYTES = 3000;

/** Upper bound on the scrollback a screen read asks tmux for. */
export const MAX_SCREEN_HISTORY_LINES = 2000;

/**
 * The last `maxBytes` (UTF-8) of a captured pane, cut at a line start.
 *
 * Each row is compacted first (padding, full-width rules and gaps, see
 * `compactRow`), then the blank rows below the last written one go: tmux pads
 * every row to the pane width and an idle pane is mostly empty rows. A single
 * last row longer than the budget keeps its tail, cut at a character, never
 * inside one.
 */
export function screenTail(captured: string, maxBytes: number): { text: string; truncated: boolean } {
  const rows = captured.split('\n').map(compactRow);
  while (rows.length > 0 && rows[rows.length - 1] === '') rows.pop();
  const kept: string[] = [];
  let bytes = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const cost = Buffer.byteLength(rows[i], 'utf8') + (kept.length > 0 ? 1 : 0);
    if (bytes + cost > maxBytes) {
      if (kept.length === 0) kept.push(tailChars(rows[i], maxBytes));
      return { text: kept.reverse().join('\n'), truncated: true };
    }
    kept.push(rows[i]);
    bytes += cost;
  }
  return { text: kept.reverse().join('\n'), truncated: false };
}

/**
 * One row, sized for reading rather than for the pane width. A TUI draws its
 * rules (`────`) and right-aligned hints across the full width: on a 200-column
 * pane one rule is 600 bytes of a 3000-byte budget. Long runs of one
 * box-drawing character shrink to `RULE_KEEP`, and a wide gap of spaces after
 * the first text on the row shrinks to `GAP_KEEP`; indentation stays, since it
 * carries code and list structure.
 */
function compactRow(row: string): string {
  const trimmed = row.trimEnd();
  const indent = trimmed.length - trimmed.trimStart().length;
  const body = trimmed
    .slice(indent)
    .replace(RULE_RUN, (run) => run.slice(0, RULE_KEEP))
    .replace(GAP_RUN, ' '.repeat(GAP_KEEP));
  return trimmed.slice(0, indent) + body;
}

const RULE_KEEP = 8;
const GAP_KEEP = 3;
/** A run of more than RULE_KEEP of the same box-drawing character (U+2500–U+257F). */
const RULE_RUN = new RegExp(`([\u2500-\u257f])\\1{${RULE_KEEP},}`, 'g');
/** More than eight spaces in a row. */
const GAP_RUN = / {9,}/g;

/** The longest suffix of `row` that fits `maxBytes`, cut between code points. */
function tailChars(row: string, maxBytes: number): string {
  const chars = Array.from(row);
  let bytes = 0;
  let start = chars.length;
  while (start > 0) {
    const cost = Buffer.byteLength(chars[start - 1], 'utf8');
    if (bytes + cost > maxBytes) break;
    bytes += cost;
    start--;
  }
  return chars.slice(start).join('');
}
