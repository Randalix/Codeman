/**
 * @fileoverview The compose dialog as a DESKTOP entry point.
 *
 * Why it exists: on a desktop there is no accessory bar, so `pasteFromClipboard()`
 * was unreachable — and with it the only place Codeman holds text in a real
 * textarea until Send. That is exactly what OS-level dictation needs: macOS/
 * Windows dictation types into whatever field has focus, so dictating straight
 * into the terminal emits provisional text the OS can then only append to (the
 * same duplication an accepted autocorrection causes). The CJK field is not an
 * alternative — it auto-flushes after 150ms — and the voice-compose overlay
 * belongs to Codeman's own transcription.
 *
 * Loaded via `vm` with a minimal fake DOM (no jsdom in this repo): the dialog
 * builds its markup with innerHTML and then looks elements up by class, so the
 * fake indexes `class="…"` occurrences per element.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

type Handler = (e: Record<string, unknown>) => void;

class FakeEl {
  tag: string;
  className = '';
  value = '';
  removed = false;
  focused = false;
  children: FakeEl[] = [];
  handlers: Record<string, Handler[]> = {};
  classList = { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false };
  private _html = '';
  private byClass = new Map<string, FakeEl>();

  constructor(tag: string) {
    this.tag = tag;
  }

  get innerHTML(): string {
    return this._html;
  }

  set innerHTML(v: string) {
    this._html = v;
    this.byClass.clear();
    for (const m of v.matchAll(/class="([\w-]+)"/g)) {
      const child = new FakeEl('div');
      child.className = m[1] as string;
      this.byClass.set(m[1] as string, child);
    }
  }

  querySelector(sel: string): FakeEl | null {
    return this.byClass.get(sel.startsWith('.') ? sel.slice(1) : sel) ?? null;
  }

  addEventListener(type: string, fn: Handler): void {
    (this.handlers[type] ||= []).push(fn);
  }

  appendChild(child: FakeEl): FakeEl {
    this.children.push(child);
    return child;
  }

  remove(): void {
    this.removed = true;
  }

  focus(): void {
    this.focused = true;
  }

  fire(type: string, ev: Record<string, unknown> = {}): void {
    for (const fn of this.handlers[type] || []) fn(ev);
  }
}

function loadKeyboardAccessory(sessionId = 'sess-1') {
  const sent: string[] = [];
  const timers: Array<() => void> = [];
  const body = new FakeEl('body');
  const document = {
    createElement: (tag: string) => new FakeEl(tag),
    body,
    getElementById: () => null,
    activeElement: null,
    addEventListener: () => {},
  };
  const app: Record<string, unknown> = {
    activeSessionId: sessionId,
    sendInput: (text: string) => sent.push(text),
    terminal: { focus: () => {} },
  };
  const context = vm.createContext({
    console,
    document,
    app,
    setTimeout: (fn: () => void) => {
      timers.push(fn);
      return 0;
    },
    clearTimeout: () => {},
    window: {},
    navigator: { userAgent: 'linux' },
    MobileDetection: { isTouchDevice: () => false },
    PathPicker: { open: () => {} },
  });
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/keyboard-accessory.js'), 'utf8');
  vm.runInContext(`${source}\nglobalThis.__KAB = KeyboardAccessoryBar;`, context);
  return { kab: (context as { __KAB: Record<string, any> }).__KAB, sent, timers, body, app };
}

/** The overlay the dialog appended, with its looked-up children. */
function openDialog(harness: ReturnType<typeof loadKeyboardAccessory>, kind: 'desktop' | 'mobile') {
  const { kab, body } = harness;
  if (kind === 'desktop') kab.openComposer();
  else kab.pasteFromClipboard();
  const overlay = body.children.at(-1)!;
  return {
    overlay,
    textarea: overlay.querySelector('.paste-textarea')!,
    send: overlay.querySelector('.paste-send')!,
    cancel: overlay.querySelector('.paste-cancel')!,
    terminal: overlay.querySelector('.paste-terminal'),
  };
}

describe('compose dialog: desktop entry point', () => {
  it('openComposer() builds the dialog with Send, Cancel and the terminal escape hatch', () => {
    const harness = loadKeyboardAccessory();
    const { overlay, textarea, terminal } = openDialog(harness, 'desktop');

    expect(overlay.removed).toBe(false);
    expect(textarea.focused).toBe(true); // focus lands in the field so dictation types there
    expect(terminal).not.toBeNull();
    expect(overlay.innerHTML).toContain('dictate');
  });

  it('leaves the mobile dialog exactly as it was (no escape hatch, same copy)', () => {
    const harness = loadKeyboardAccessory();
    const { overlay, terminal } = openDialog(harness, 'mobile');

    expect(terminal).toBeNull();
    expect(overlay.innerHTML).toContain('Long-press to paste text');
  });

  it('does nothing without an active session', () => {
    const harness = loadKeyboardAccessory();
    harness.app.activeSessionId = undefined;
    harness.kab.openComposer();
    expect(harness.body.children).toHaveLength(0);
  });

  it('Send delivers the text once, then Enter — and closes', () => {
    const harness = loadKeyboardAccessory();
    const { overlay, textarea, send } = openDialog(harness, 'desktop');

    textarea.value = 'reviewed prompt';
    send.fire('click');

    expect(overlay.removed).toBe(true);
    expect(harness.sent).toEqual(['reviewed prompt']);
    harness.timers.forEach((fn) => fn()); // the 80ms Enter
    expect(harness.sent).toEqual(['reviewed prompt', '\r']);
  });

  it('Enter never submits — the Send button is the only way out', () => {
    // #359's acceptance criterion. In a real textarea Enter inserts a newline
    // natively, so what must hold here is that NO handler turns it into a send.
    const harness = loadKeyboardAccessory();
    const { overlay, textarea } = openDialog(harness, 'desktop');

    textarea.fire('keydown', { key: 'Enter' });
    overlay.fire('keydown', { key: 'Enter' });

    expect(harness.sent).toEqual([]);
    expect(overlay.removed).toBe(false);
  });

  it('Escape closes without sending, and swallows the event', () => {
    const harness = loadKeyboardAccessory();
    const { overlay, textarea } = openDialog(harness, 'desktop');
    textarea.value = 'half typed';
    // A real event object, so preventDefault/stopPropagation are observable —
    // the page has its own Escape handling and must not also run.
    const ev = {
      key: 'Escape',
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        this.propagationStopped = true;
      },
    };

    overlay.fire('keydown', ev);

    expect(overlay.removed).toBe(true);
    expect(harness.sent).toEqual([]);
    expect(ev.defaultPrevented).toBe(true);
    expect(ev.propagationStopped).toBe(true);
  });

  it('keeps a per-session draft across close, and clears it on Send', () => {
    const harness = loadKeyboardAccessory('sess-A');
    const first = openDialog(harness, 'desktop');
    first.textarea.value = 'dictated but not sent';
    first.textarea.fire('input');
    first.cancel.fire('click');
    expect(first.overlay.removed).toBe(true);

    // Reopening the same session restores it…
    const second = openDialog(harness, 'desktop');
    expect(second.textarea.value).toBe('dictated but not sent');

    // …Send clears it…
    second.send.fire('click');
    const third = openDialog(harness, 'desktop');
    expect(third.textarea.value).toBe('');

    // …and another session never sees it.
    third.cancel.fire('click');
    harness.app.activeSessionId = 'sess-B';
    const other = openDialog(harness, 'desktop');
    expect(other.textarea.value).toBe('');
  });

  it('keeps no draft for the mobile dialog', () => {
    const harness = loadKeyboardAccessory('sess-A');
    const first = openDialog(harness, 'mobile');
    first.textarea.value = 'mobile text';
    first.textarea.fire('input');
    first.cancel.fire('click');

    const second = openDialog(harness, 'mobile');
    expect(second.textarea.value).toBe('');
  });

  it('never delivers a draft to a session the user switched to mid-compose', () => {
    const harness = loadKeyboardAccessory('sess-A');
    const { overlay, textarea, send } = openDialog(harness, 'desktop');
    textarea.value = 'prompt for A';
    textarea.fire('input');

    harness.app.activeSessionId = 'sess-B'; // user clicked another tab
    send.fire('click');

    expect(harness.sent).toEqual([]); // nothing reaches B
    expect(overlay.removed).toBe(true);
    // …and the text is still there when A is opened again.
    harness.app.activeSessionId = 'sess-A';
    expect(openDialog(harness, 'desktop').textarea.value).toBe('prompt for A');
  });

  it('Use terminal keyboard closes the dialog and refocuses the terminal', () => {
    const harness = loadKeyboardAccessory();
    let focused = false;
    harness.app.terminal = { focus: () => (focused = true) };
    const { overlay, terminal } = openDialog(harness, 'desktop');

    terminal!.fire('click');

    expect(overlay.removed).toBe(true);
    expect(focused).toBe(true);
    expect(harness.sent).toEqual([]);
  });
});

/**
 * The shortcut has to go through the registry (not a raw keydown), or a rebind
 * and the per-shortcut disable in App Settings would not reach it — and the
 * toolbar button is the discoverable half.
 */
describe('compose dialog: wiring', () => {
  const read = (p: string) => readFileSync(resolve(import.meta.dirname, `../src/web/public/${p}`), 'utf8');

  it('registers Ctrl+Shift+Enter and a dispatch handler', () => {
    const app = read('app.js');
    const entry = app.slice(app.indexOf("id: 'compose-prompt'"));
    expect(entry).toContain("bindings: [{ modifiers: ['ctrl', 'shift'], key: 'Enter' }]");
    expect(entry).toContain("action: 'openComposePrompt'");
    expect(app).toContain('openComposePrompt: () => KeyboardAccessoryBar.openComposer()');
  });

  it('has a desktop toolbar button that calls the dialog', () => {
    const html = read('index.html');
    expect(html).toContain('id="composePromptBtn"');
    expect(html).toContain('KeyboardAccessoryBar.openComposer()');
  });

  it('hides that button on handheld widths, like the voice button', () => {
    const css = read('styles.css');
    const block = css.slice(css.indexOf('.btn-toolbar.btn-compose'));
    expect(block).toContain('@media (max-width: 1023px)');
    expect(block).toContain('display: none !important');
  });
});
