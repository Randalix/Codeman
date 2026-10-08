/**
 * @fileoverview The prompt composer's desktop entry point. The composer itself
 * (`KeyboardAccessoryBar.composePrompt()`, per-session draft, Enter = newline, Send
 * delivers to the session it opened for) is upstream's and tested there; this pins
 * only that a desktop can reach it at all — the accessory bar's Compose key is
 * mobile-only, and OS-level dictation needs a field that does not auto-flush.
 *
 * The shortcut goes through the registry (not a raw keydown), so a rebind and the
 * per-shortcut disable in App Settings reach it; the toolbar button is the
 * discoverable half.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(resolve(import.meta.dirname, `../src/web/public/${p}`), 'utf8');

describe('prompt composer: desktop entry point', () => {
  it('registers Ctrl+Shift+Enter and dispatches it to the composer', () => {
    const app = read('app.js');
    const entry = app.slice(app.indexOf("id: 'compose-prompt'"));
    expect(entry).toContain("bindings: [{ modifiers: ['ctrl', 'shift'], key: 'Enter' }]");
    expect(entry).toContain("action: 'openComposePrompt'");
    expect(app).toContain('openComposePrompt: () => KeyboardAccessoryBar.composePrompt()');
  });

  it('has a desktop toolbar button that opens the composer', () => {
    const html = read('index.html');
    expect(html).toContain('id="composePromptBtn"');
    expect(html).toContain('KeyboardAccessoryBar.composePrompt()');
  });

  it('hides that button on handheld widths, like the voice button', () => {
    const css = read('styles.css');
    const block = css.slice(css.indexOf('.btn-toolbar.btn-compose'));
    expect(block).toContain('@media (max-width: 1023px)');
    expect(block).toContain('display: none !important');
  });

  it('the composer it opens still exists under that name', () => {
    expect(read('keyboard-accessory.js')).toMatch(/^\s{2}composePrompt\(\) \{/m);
  });
});
