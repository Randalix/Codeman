/**
 * Root config so a bare `npx vitest run` gets the SAME gate as `npm test` —
 * above all `test/setup.ts`, which points `$HOME` at a throwaway dir. Without this
 * file vitest found no config here and ran every suite against the real home
 * (incident 2026-09-24; `src/config/instance.ts` now also refuses that outright).
 */
export { default } from './config/vitest.ci.config';
