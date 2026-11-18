/**
 * @fileoverview Reading a numbered-option dialog off a pane (`isOptionDialogOnScreen`,
 * `Session.dialogOnScreen`), and suspend refusing a session that sits on one.
 *
 * A Claude session parked on a permission, question or plan dialog reads as idle, so
 * before this a suspend stopped the CLI and the dialog was gone (checked live on
 * 2.1.327). The dialog frames are real captures in `test/fixtures/claude-dialogs/`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isOptionDialogOnScreen, OPTION_DIALOG_TAIL_ROWS } from '../src/session-activity.js';
import { Session } from '../src/session.js';
import { SessionSuspendRegistry, type SessionSuspendDeps, type SuspendableSession } from '../src/session-suspend.js';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures/claude-dialogs', name), 'utf8');

const DIALOGS = [
  'permission-bash-v2.1.327.txt',
  'plan-approval-v2.1.327.txt',
  'ask-user-question-v2.1.327.txt',
  'ask-user-question-cursor-2-v2.1.327.txt',
  'notice-auto-mode-v2.1.327.txt',
];

/** An idle Claude screen in the layout of a live 2.1.327 pane: answer, rules, composer, footer. */
const idle = (above: string, composer = '❯ ') =>
  [
    above,
    '✻ Crunched for 4s · done 14:43',
    '──────────────────────────────────────────',
    composer,
    '──────────────────────────────────────────',
    '  Sonnet 5.5  in:100,837 out:275  ctx:10%  cache:cold',
    '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    '                          new task? /clear to save 101.1k tokens',
    '',
  ].join('\n');

describe('isOptionDialogOnScreen', () => {
  it.each(DIALOGS)('sees the dialog in %s', (name) => {
    expect(isOptionDialogOnScreen(fixture(name), '❯')).toBe(true);
  });

  it('an idle composer is no dialog', () => {
    expect(isOptionDialogOnScreen(idle('● Done. The file is there.'), '❯')).toBe(false);
  });

  it('an earlier prompt that quoted a numbered list does not count: the composer is the last glyph row', () => {
    const screen = idle(
      ['❯ 1. fix the parser', '  2. fix the tests', '', '● Both fixed.', '  1. parser', '  2. tests'].join('\n')
    );
    expect(isOptionDialogOnScreen(screen, '❯')).toBe(false);
  });

  it('a draft that starts with "1. " is no dialog without a second option', () => {
    expect(isOptionDialogOnScreen(idle('● Done.', '❯ 1. next step'), '❯')).toBe(false);
  });

  it('a cursor row further up than the dialog can reach is not read as live', () => {
    const tail = Array.from({ length: OPTION_DIALOG_TAIL_ROWS + 1 }, (_v, i) => `output line ${i}`);
    expect(isOptionDialogOnScreen(['❯ 1. Yes', '  2. No', ...tail].join('\n'), '❯')).toBe(false);
  });

  it('reads through ANSI codes and a boxed frame', () => {
    expect(isOptionDialogOnScreen('Proceed?\n│ \u001b[36m❯ 1. Yes\u001b[0m │\n│   2. No  │\n', '❯')).toBe(true);
  });

  it('nothing to read is no dialog', () => {
    expect(isOptionDialogOnScreen('', '❯')).toBe(false);
    expect(isOptionDialogOnScreen(null, '❯')).toBe(false);
  });
});

describe('Session.dialogOnScreen', () => {
  const session = (mode: string) =>
    new Session({
      workingDir: '/tmp',
      mode,
      mux: { isAvailable: () => true, capturePaneText: () => '' } as never,
      muxSession: { muxName: 'codeman-test', sessionId: 'test', createdAt: Date.now() },
    } as ConstructorParameters<typeof Session>[0]);

  it('claude declares optionDialogs and reads the dialog', () => {
    const s = session('claude');
    expect(s.dialogOnScreen(fixture('permission-bash-v2.1.327.txt'))).toBe(true);
    expect(s.dialogOnScreen(idle('● Done.'))).toBe(false);
  });

  it('a CLI that does not declare it never reads one', () => {
    expect(session('shell').dialogOnScreen(fixture('permission-bash-v2.1.327.txt'))).toBe(false);
  });
});

describe('suspend with a dialog open', () => {
  class FakeSession implements SuspendableSession {
    id = 'sess-dialog-0001';
    mode = 'claude';
    status = 'idle';
    isWorking = false;
    muxName = 'codeman-sess';
    suspended = false;
    watching: string | null = null;
    stops = 0;
    private reader = new Session({
      workingDir: '/tmp',
      mode: 'claude',
      mux: { isAvailable: () => true, capturePaneText: () => '' } as never,
      muxSession: { muxName: 'codeman-test', sessionId: 'test', createdAt: Date.now() },
    } as ConstructorParameters<typeof Session>[0]);
    dialogOnScreen(text: string) {
      return this.reader.dialogOnScreen(text);
    }
    backgroundWorkOnScreen(text: string) {
      return this.reader.backgroundWorkOnScreen(text);
    }
    setSuspended(at: number | null) {
      this.suspended = at !== null;
    }
    async restartCli() {
      return true;
    }
    async writeViaMux() {
      return true;
    }
    write() {
      return true;
    }
  }

  const deps = (s: FakeSession, screen: string | null): SessionSuspendDeps => ({
    stopPane: async () => {
      s.stops++;
      return true;
    },
    capturePane: () => screen,
    persist: () => {},
    now: () => 1_000,
    sleep: async () => {},
    log: () => {},
  });

  it.each(DIALOGS)('refuses with dialog-open on %s and stops nothing', async (name) => {
    const s = new FakeSession();
    const result = await new SessionSuspendRegistry(deps(s, fixture(name))).suspend(s);
    expect(result).toMatchObject({ ok: false, reason: 'dialog-open' });
    expect(s.stops).toBe(0);
    expect(s.suspended).toBe(false);
  });

  it('suspends the same session once the dialog is answered', async () => {
    const s = new FakeSession();
    expect((await new SessionSuspendRegistry(deps(s, idle('● Done.'))).suspend(s)).ok).toBe(true);
    expect(s.stops).toBe(1);
  });

  it('an unreadable pane is no evidence of a dialog', async () => {
    const s = new FakeSession();
    expect((await new SessionSuspendRegistry(deps(s, null)).suspend(s)).ok).toBe(true);
  });
});
