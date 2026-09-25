/**
 * A registry gate is evaluated against the version of ITS OWN CLI.
 *
 * `buildSpawnCommandFromRegistry` used to resolve every entry's gates against claude's
 * version. That was harmless while only claude declared a gate; codex's `noDaemon` gate
 * (minVersion 0.157.0) would have passed against any claude 2.1.x — and `--no-daemon`
 * makes codex 0.154 exit 2, a dead pane.
 *
 * Strategy: mock the per-mode resolver, render without an explicit version.
 *
 * Port: N/A (no server / no real CLI)
 */
import { describe, expect, it, vi } from 'vitest';

const versions: Record<string, string | null> = { claude: '2.1.300', codex: '0.154.0' };
vi.mock('../src/utils/cli-resolver.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/utils/cli-resolver.js')>()),
  resolveSessionCliVersion: (mode: string) => versions[mode] ?? null,
}));

// The old code path asked claude's own probe for EVERY entry; make it answer like a real
// install would, so a regression shows up as `--no-daemon` on codex 0.154.
vi.mock('../src/utils/claude-cli-resolver.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/utils/claude-cli-resolver.js')>()),
  getClaudeCliVersion: () => '2.1.300',
}));

const { getCli } = await import('../src/config/cli-registry/registry.js');
const { buildSpawnCommandFromRegistry } = await import('../src/session-cli-registry-bridge.js');

const codex = () => buildSpawnCommandFromRegistry(getCli('codex')!, { mode: 'codex', sessionId: 's' });

describe('registry gates use the version of their own CLI', () => {
  it("does not pass codex's noDaemon gate on claude's (newer-looking) version", () => {
    versions.codex = '0.154.0';
    expect(codex()).toBe('codex');
  });

  it("passes it on codex's own version", () => {
    versions.codex = '0.157.0';
    expect(codex()).toBe('codex --no-daemon');
  });

  it('fails closed when codex reports no version', () => {
    versions.codex = null;
    expect(codex()).toBe('codex');
  });
});
