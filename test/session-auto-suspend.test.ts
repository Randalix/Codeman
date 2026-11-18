/**
 * @fileoverview Auto-suspend (src/session-auto-suspend.ts): which sessions a tick suspends,
 * when idle starts counting, what it leaves alone, and how the settings are read.
 */
import { describe, expect, it } from 'vitest';
import {
  AUTO_SUSPEND_DEFAULT_IDLE_MINUTES,
  AUTO_SUSPEND_RETRY_MS,
  AutoSuspendService,
  autoSuspendSettingsFrom,
  type AutoSuspendableSession,
  type AutoSuspendSettings,
} from '../src/session-auto-suspend.js';
import type { SuspendResult } from '../src/session-suspend.js';

const MIN = 60_000;
const T0 = 1_700_000_000_000;

class FakeSession implements AutoSuspendableSession {
  mode = 'claude';
  status = 'idle';
  isWorking = false;
  muxName = 'codeman-x';
  suspended = false;
  remote: { owned?: boolean } | null = null;
  lastRealPromptAt = 0;
  lastHumanInputAt = 0;
  turnEndedAt: number | null = null;
  constructor(public id: string) {}
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

function harness(opts: { settings?: Partial<AutoSuspendSettings>; refuse?: SuspendResult } = {}) {
  let now = T0;
  const sessions: FakeSession[] = [];
  const calls: string[] = [];
  const logs: string[] = [];
  const resumed = new Map<string, number>();
  let settings: AutoSuspendSettings = { enabled: true, idleMinutes: 60, ...opts.settings };
  let settingsError: Error | null = null;
  let refuse = opts.refuse ?? null;
  const service = new AutoSuspendService({
    sessions: () => sessions,
    registry: {
      suspend: async (s) => {
        calls.push(s.id);
        if (refuse) return refuse;
        s.setSuspended(now);
        return { ok: true };
      },
      isHolding: (s) => s.suspended,
      lastResumedAt: (id) => resumed.get(id) ?? 0,
    },
    readSettings: async () => {
      if (settingsError) throw settingsError;
      return settings;
    },
    now: () => now,
    log: (m) => logs.push(m),
  });
  return {
    service,
    sessions,
    calls,
    logs,
    resumed,
    advance: (ms: number) => (now += ms),
    now: () => now,
    setSettings: (s: Partial<AutoSuspendSettings>) => (settings = { ...settings, ...s }),
    failSettings: (e: Error | null) => (settingsError = e),
    setRefuse: (r: SuspendResult | null) => (refuse = r),
    add: (id: string) => {
      const s = new FakeSession(id);
      sessions.push(s);
      return s;
    },
  };
}

describe('autoSuspendSettingsFrom', () => {
  it('is off with the default idle time when nothing is set', () => {
    expect(autoSuspendSettingsFrom({})).toEqual({ enabled: false, idleMinutes: AUTO_SUSPEND_DEFAULT_IDLE_MINUTES });
    expect(autoSuspendSettingsFrom(null)).toEqual({ enabled: false, idleMinutes: 60 });
  });

  it('takes a valid value and falls back on an invalid one', () => {
    expect(autoSuspendSettingsFrom({ autoSuspendEnabled: true, autoSuspendIdleMinutes: 30 })).toEqual({
      enabled: true,
      idleMinutes: 30,
    });
    for (const bad of [4, 1441, 12.5, '30', null]) {
      expect(autoSuspendSettingsFrom({ autoSuspendIdleMinutes: bad }).idleMinutes).toBe(60);
    }
    expect(autoSuspendSettingsFrom({ autoSuspendEnabled: 'yes' }).enabled).toBe(false);
  });
});

describe('AutoSuspendService', () => {
  it('suspends nothing while the setting is off', async () => {
    const h = harness({ settings: { enabled: false } });
    h.add('a');
    h.advance(600 * MIN);
    expect(await h.service.tick()).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it('counts idle from its own start, so a restart does not suspend everything at once', async () => {
    const h = harness();
    h.add('a'); // never prompted: every timestamp is 0
    h.advance(59 * MIN);
    expect(await h.service.tick()).toEqual([]);
    h.advance(1 * MIN);
    expect(await h.service.tick()).toEqual(['a']);
    expect(h.logs.some((l) => l.includes('suspended after 60 min idle'))).toBe(true);
  });

  it('a prompt, a keystroke, a turn end or a resume each restart the clock', async () => {
    const h = harness();
    const s = h.add('a');
    h.advance(120 * MIN);
    for (const touch of [
      () => (s.lastRealPromptAt = h.now()),
      () => (s.lastHumanInputAt = h.now()),
      () => (s.turnEndedAt = h.now()),
      () => h.resumed.set('a', h.now()),
    ]) {
      touch();
      h.advance(59 * MIN);
      expect(await h.service.tick()).toEqual([]);
      h.advance(2 * MIN);
    }
    expect(await h.service.tick()).toEqual(['a']);
  });

  it('follows a changed idle time on the next tick', async () => {
    const h = harness();
    h.add('a');
    h.advance(20 * MIN);
    expect(await h.service.tick()).toEqual([]);
    h.setSettings({ idleMinutes: 15 });
    expect(await h.service.tick()).toEqual(['a']);
  });

  it('leaves SSH sessions, other CLIs, working and suspended sessions alone, without a log line', async () => {
    const h = harness();
    h.add('remote').remote = { owned: true };
    h.add('shell').mode = 'shell';
    h.add('busy').isWorking = true;
    h.add('done').suspended = true;
    h.advance(600 * MIN);
    expect(await h.service.tick()).toEqual([]);
    expect(h.calls).toEqual([]);
    expect(h.logs).toEqual([]);
  });

  it('a refused session is tried again after the retry time, and the reason is logged once', async () => {
    const h = harness({ refuse: { ok: false, reason: 'dialog-open', message: 'dialog' } });
    h.add('a');
    h.advance(61 * MIN);
    await h.service.tick();
    h.advance(MIN);
    await h.service.tick();
    expect(h.calls).toEqual(['a']);
    h.advance(AUTO_SUSPEND_RETRY_MS);
    await h.service.tick();
    expect(h.calls).toEqual(['a', 'a']);
    expect(h.logs.filter((l) => l.includes('left running (dialog-open)'))).toHaveLength(1);
    h.setRefuse(null);
    h.advance(AUTO_SUSPEND_RETRY_MS);
    expect(await h.service.tick()).toEqual(['a']);
  });

  it('an unreadable settings file suspends nothing and is logged once', async () => {
    const h = harness();
    h.add('a');
    h.advance(600 * MIN);
    h.failSettings(new Error('bad json'));
    await h.service.tick();
    await h.service.tick();
    expect(h.calls).toEqual([]);
    expect(h.logs.filter((l) => l.includes('settings unreadable'))).toHaveLength(1);
    h.failSettings(null);
    expect(await h.service.tick()).toEqual(['a']);
  });

  it('never runs two passes at once', async () => {
    const h = harness();
    h.add('a');
    h.advance(61 * MIN);
    const [first, second] = await Promise.all([h.service.tick(), h.service.tick()]);
    expect(first).toEqual(['a']);
    expect(second).toEqual([]);
    expect(h.calls).toEqual(['a']);
  });
});
