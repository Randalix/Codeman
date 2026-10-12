/**
 * Why TmuxManager.scrollClientsByLinefeed() exists: xterm.js moves a line that a
 * linefeed scrolls off the top into scrollback, but drops a line that `CSI N S`
 * (SU) scrolls off. tmux scrolls a client with SU whenever one output burst moves
 * the pane by more than a line, so without the override those rows vanished from
 * the browser's history. If xterm.js ever keeps SU lines, the override is moot.
 */
import { describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/headless';

function render(data: string): Promise<string[]> {
  const term = new Terminal({ cols: 40, rows: 5, scrollback: 100, allowProposedApi: true });
  return new Promise((resolve) => {
    term.write(data, () => {
      const buffer = term.buffer.active;
      const lines: string[] = [];
      for (let i = 0; i < buffer.length; i++) {
        const text = buffer.getLine(i)?.translateToString(true) ?? '';
        if (text) lines.push(text);
      }
      term.dispose();
      resolve(lines);
    });
  });
}

describe('xterm scrollback across scroll sequences', () => {
  const screen = 'L1\r\nL2\r\nL3\r\nL4\r\nL5';

  it('keeps lines a linefeed scrolls off (what tmux sends without indn)', async () => {
    expect(await render(`${screen}\r\nL6\r\nL7`)).toEqual(['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7']);
  });

  it('drops lines CSI N S scrolls off (what tmux sends with indn)', async () => {
    expect(await render(`${screen}\x1b[2S\x1b[4;1HL6\x1b[5;1HL7`)).toEqual(['L3', 'L4', 'L5', 'L6', 'L7']);
  });
});
