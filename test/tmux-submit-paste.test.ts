/**
 * Covers `buildPasteTextCommands()`: the text half of a text+Enter submit
 * (`sendInput` / `sendInputToPane`) goes in as ONE bracketed paste.
 *
 * Why: `send-keys -l` typed the text as an unmarked burst, and Codex's paste-burst
 * heuristic folded the Enter that followed 50 ms later into the paste as a newline —
 * the prompt sat in the composer unsubmitted (always at 1500 chars, sometimes for a
 * one-line mailbox nudge). With `paste-buffer -p` the paste is marked and the
 * separate Enter submits.
 *
 * Strategy: pure command shape, plus a round trip through a real shell with a fake
 * `tmux` that prints its argv — so quoting and tmux's trailing-`;` rule are checked
 * on the bytes a shell actually hands over. No real tmux.
 *
 * Port: N/A (no server / no real tmux)
 */
import { execSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { buildPasteTextCommands } from '../src/tmux-manager.js';

const FAKE_TMUX = `${JSON.stringify(process.execPath)} -e 'console.log(JSON.stringify(process.argv.slice(1)))' --`;

function argvOf(cmd: string): string[] {
  return JSON.parse(execSync(cmd, { encoding: 'utf-8' })) as string[];
}

describe('buildPasteTextCommands', () => {
  it('fills a buffer, then pastes it bracketed into the target and deletes it', () => {
    const [set, paste, ...rest] = buildPasteTextCommands('tmux -L codeman', 'codeman-abc12345', 'hello');
    expect(rest).toEqual([]);
    const buffer = /set-buffer -b (\S+) -- /.exec(set)?.[1];
    expect(buffer).toMatch(/^codeman-submit-\d+-\d+$/);
    expect(set).toBe(`tmux -L codeman set-buffer -b ${buffer} -- 'hello'`);
    expect(paste).toBe(`tmux -L codeman paste-buffer -p -d -b ${buffer} -t 'codeman-abc12345'`);
  });

  it('never types the text with send-keys (the unmarked burst Codex misreads)', () => {
    for (const cmd of buildPasteTextCommands('tmux', 'codeman-abc12345', 'lies deine Mailbox')) {
      expect(cmd).not.toContain('send-keys');
    }
  });

  it('uses a fresh buffer per call, so concurrent sends cannot paste each other', () => {
    const a = buildPasteTextCommands('tmux', 't', 'a')[0];
    const b = buildPasteTextCommands('tmux', 't', 'b')[0];
    expect(/-b (\S+)/.exec(a)?.[1]).not.toBe(/-b (\S+)/.exec(b)?.[1]);
  });

  it.each([
    ['quotes and shell syntax', `it's "quoted" $HOME \`id\` $(id) & | > <`],
    ['tmux format syntax', '#{session_name} #S'],
    ['leading dash', '-t other --help'],
    ['non-ASCII', 'Mailbox lesen — äöü “x”'],
    ['a long nudge', 'x'.repeat(1500)],
  ])('hands the text to tmux unchanged through the shell: %s', (_label, text) => {
    const [set] = buildPasteTextCommands(FAKE_TMUX, 't', text);
    expect(argvOf(set).at(-1)).toBe(text);
  });

  it.each([
    ['x;', 'x\\;'],
    [';', '\\;'],
    ['x;;', 'x;\\;'],
    ['x\\;', 'x\\\\;'],
  ])('escapes a trailing ";" (tmux command separator): %s', (text, expected) => {
    const [set] = buildPasteTextCommands(FAKE_TMUX, 't', text);
    expect(argvOf(set).at(-1)).toBe(expected);
  });

  it('leaves a ";" inside the text alone', () => {
    const [set] = buildPasteTextCommands(FAKE_TMUX, 't', 'a; b');
    expect(argvOf(set).at(-1)).toBe('a; b');
  });
});
