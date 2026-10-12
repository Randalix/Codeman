/**
 * @fileoverview Shell brace sets in a path — `…/{vorher,nachher}/synth-{sedan,jeep}/{a,b}.wav`
 * — as ONE link that expands to the files it names.
 *
 * Real code under test: `findFilePathLinks`, `expandBracePath`, `bracePathPrefixDir`
 * and `terminalPathLine` from constants.js, in a `vm` context.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

type Link = { path: string; index: number; folder?: true; braces?: true };
type Line = { startRow: number; endRow: number; text: string };
type Helpers = {
  terminalPathLine: (buffer: unknown, row: number, cols: number, maxRows?: number) => Line | null;
  findFilePathLinks: (text: string) => Link[];
  expandBracePath: (text: string, limit?: number) => { paths: string[]; tooMany: boolean } | null;
  bracePathPrefixDir: (text: string) => string | null;
};

function loadHelpers(): Helpers {
  const context = vm.createContext({});
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/constants.js'), 'utf8');
  vm.runInContext(
    `${source}\nglobalThis.__h = { findFilePathLinks, expandBracePath, bracePathPrefixDir, terminalPathLine };`,
    context,
    { filename: 'constants.js' }
  );
  return (context as { __h: Helpers }).__h;
}

const { findFilePathLinks, expandBracePath, bracePathPrefixDir, terminalPathLine } = loadHelpers();

/** An xterm buffer stand-in: hard-broken rows (no `isWrapped`), as Claude Code emits them. */
function buffer(lines: string[], cols = 80) {
  return {
    length: lines.length,
    getLine: (row: number) =>
      row >= 0 && row < lines.length
        ? {
            isWrapped: false,
            translateToString: (trim?: boolean) => (trim ? lines[row].replace(/\s+$/, '') : lines[row].padEnd(cols)),
          }
        : undefined,
  };
}

const ROOTED =
  '/mnt/raid1/neon_getaway-engine-audio/builds/captures/2026-10-12/enginesim_v2/uebernahme/{vorher,nachher}/synth-{sedan,jeep}/{leerlauf,teillast,vollgas,schub,start}.wav';

describe('findFilePathLinks: brace sets', () => {
  it('links a rooted set as ONE path, braces included', () => {
    expect(findFilePathLinks(`Dateien: ${ROOTED}`)).toEqual([{ path: ROOTED, index: 9, braces: true }]);
  });

  it('links the same set written without the leading slash', () => {
    const relative = ROOTED.slice(1);
    expect(findFilePathLinks(`  ${relative}  `)).toEqual([{ path: relative, index: 2, braces: true }]);
  });

  it('links a set that ends on a brace (a folder set) and one in a command', () => {
    expect(findFilePathLinks('ls /tmp/renders/{a,b}')).toEqual([
      { path: '/tmp/renders/{a,b}', index: 3, braces: true },
    ]);
    expect(findFilePathLinks('ls src/{a,b}.ts -la').map((f) => f.path)).toEqual(['src/{a,b}.ts']);
  });

  it('leaves sentence punctuation after the set out of the link', () => {
    expect(findFilePathLinks('siehe /tmp/x/{a,b}.png.').map((f) => f.path)).toEqual(['/tmp/x/{a,b}.png']);
    expect(findFilePathLinks('(/tmp/x/{a,b}.png)').map((f) => f.path)).toEqual(['/tmp/x/{a,b}.png']);
  });

  it('does not take shell variables, JSON, URLs or a single-name group for a set', () => {
    for (const text of [
      'cd ${HOME}/{a,b}/x.png',
      'echo $(pwd)/{a,b}.png',
      '{"a": 1, "b": 2}',
      'x = {a,b}',
      'https://example.com/{a,b}/c.png',
      '/tmp/x/{only}/c.png',
    ]) {
      expect(
        findFilePathLinks(text).some((f) => f.braces),
        text
      ).toBe(false);
    }
  });

  it('stays linear on a token that is nothing but opening braces', () => {
    const start = Date.now();
    expect(findFilePathLinks(`/a/${'{'.repeat(4000)}`).some((f) => f.braces)).toBe(false);
    expect(Date.now() - start).toBeLessThan(100);
  });

  it('keeps the plain forms exactly as they were', () => {
    expect(findFilePathLinks('/mnt/raid1/x/shot.png').map((f) => f.path)).toEqual(['/mnt/raid1/x/shot.png']);
    expect(findFilePathLinks('builds/captures/shot.png ./notes.md').map((f) => f.path)).toEqual([
      'builds/captures/shot.png',
      './notes.md',
    ]);
  });
});

describe('expandBracePath', () => {
  it('expands like bash: first group varies slowest', () => {
    expect(expandBracePath('/a/{x,y}/{1,2}.png')).toEqual({
      paths: ['/a/x/1.png', '/a/x/2.png', '/a/y/1.png', '/a/y/2.png'],
      tooMany: false,
    });
  });

  it('expands the whole example to 20 files in text order', () => {
    const result = expandBracePath(ROOTED);
    expect(result?.paths).toHaveLength(20);
    expect(result?.paths[0]).toMatch(/uebernahme\/vorher\/synth-sedan\/leerlauf\.wav$/);
    expect(result?.paths[4]).toMatch(/uebernahme\/vorher\/synth-sedan\/start\.wav$/);
    expect(result?.paths[5]).toMatch(/uebernahme\/vorher\/synth-jeep\/leerlauf\.wav$/);
    expect(result?.paths[19]).toMatch(/uebernahme\/nachher\/synth-jeep\/start\.wav$/);
  });

  it('handles nesting and empty alternatives', () => {
    expect(expandBracePath('/a/{b,c{1,2}}.png')?.paths).toEqual(['/a/b.png', '/a/c1.png', '/a/c2.png']);
    expect(expandBracePath('/a/x{,-old}.png')?.paths).toEqual(['/a/x.png', '/a/x-old.png']);
  });

  it('caps the number of combinations instead of building them', () => {
    const many = '/a/{1,2,3,4,5,6,7,8,9,10}{1,2,3,4,5,6,7,8,9,10}{1,2}.png';
    expect(expandBracePath(many, 100)).toEqual({ paths: [], tooMany: true });
    expect(expandBracePath(many, 200)?.paths).toHaveLength(200);
  });

  it('answers null when there is nothing to expand', () => {
    expect(expandBracePath('/a/b.png')).toBeNull();
    expect(expandBracePath('/a/{b}/c.png')).toBeNull();
    expect(expandBracePath('/a/{b,c/d.png')).toBeNull();
  });
});

describe('bracePathPrefixDir', () => {
  it('is the folder in front of the first real set', () => {
    expect(bracePathPrefixDir(ROOTED)).toBe(
      '/mnt/raid1/neon_getaway-engine-audio/builds/captures/2026-10-12/enginesim_v2/uebernahme'
    );
    expect(bracePathPrefixDir('src/{a,b}.ts')).toBe('src');
    expect(bracePathPrefixDir('/tmp/x{a,b}/c.png')).toBe('/tmp');
    expect(bracePathPrefixDir('/{a,b}/c.png')).toBe('/');
    expect(bracePathPrefixDir('~/{a,b}/c.png')).toBe('~/');
    expect(bracePathPrefixDir('~/x/{a,b}.png')).toBe('~/x');
    expect(bracePathPrefixDir('{a,b}/c.png')).toBeNull();
  });
});

describe('a brace set a program broke over lines itself', () => {
  it('is glued back together at a comma inside a group', () => {
    const rows = [
      '  Dateien: /mnt/raid1/x/builds/{vorher,nachher}/synth-{sedan,   ',
      '  jeep}/{leerlauf,teillast,vollgas}.wav                          ',
    ].map((r) => r.replace(/\s+$/, ''));
    const line = terminalPathLine(buffer(rows, 64), 0, 64)!;
    expect(line.endRow).toBe(1);
    expect(findFilePathLinks(line.text).map((f) => f.path)).toEqual([
      '/mnt/raid1/x/builds/{vorher,nachher}/synth-{sedan,jeep}/{leerlauf,teillast,vollgas}.wav',
    ]);
  });

  it('does not glue a comma-ended prose line to the next one', () => {
    const rows = ['  siehe /mnt/raid1/x/builds/vorher,', '  jeep/leerlauf.wav ist neu'];
    expect(terminalPathLine(buffer(rows, 64), 0, 64)).toMatchObject({ startRow: 0, endRow: 0 });
  });
});
