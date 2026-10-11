/**
 * @fileoverview `screenTail`: the byte-budgeted rendered pane text behind
 * `agent read --tail`.
 */
import { describe, it, expect } from 'vitest';
import { screenTail } from '../src/utils/screen-text.js';

describe('screenTail', () => {
  it('drops the row padding and the blank rows below the last written one', () => {
    expect(screenTail('● done      \n❯ hi   \n      \n\n', 100)).toEqual({ text: '● done\n❯ hi', truncated: false });
  });

  it('keeps whole rows from the end within the budget and reports the cut', () => {
    expect(screenTail('aaaa\nbbbb\ncccc', 9)).toEqual({ text: 'bbbb\ncccc', truncated: true });
  });

  it('counts UTF-8 bytes, not UTF-16 units', () => {
    // '●' is 3 bytes: "● x" = 5 bytes, "\n● y" = 6 more.
    expect(screenTail('● x\n● y', 10)).toEqual({ text: '● y', truncated: true });
    expect(screenTail('● x\n● y', 11)).toEqual({ text: '● x\n● y', truncated: false });
  });

  it('keeps the tail of a single row longer than the budget, cut between characters', () => {
    expect(screenTail('xx●●●', 7)).toEqual({ text: '●●', truncated: true });
  });

  it('shrinks full-width rules and wide gaps, keeps indentation', () => {
    const rule = '─'.repeat(200);
    const hint = `  ⏵⏵ bypass permissions on${' '.repeat(120)}/rc`;
    expect(screenTail(`${rule}\n❯ hi\n${rule}\n${hint}`, 3000).text).toBe(
      '────────\n❯ hi\n────────\n  ⏵⏵ bypass permissions on   /rc'
    );
    // Indentation is structure (code, nested lists), not padding.
    expect(screenTail('            deep();', 100).text).toBe('            deep();');
    // Short runs are content, not layout.
    expect(screenTail('a ──── b  c', 100).text).toBe('a ──── b  c');
  });

  it('returns nothing for an empty pane', () => {
    expect(screenTail('   \n\n', 100)).toEqual({ text: '', truncated: false });
  });
});
