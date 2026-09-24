/**
 * @fileoverview Entry point of the standalone `codeman agent` CLI that Codeman
 * copies onto an SSH remote host (see `remote-agent-cli.ts`).
 *
 * A remote host has no Codeman checkout, so the full `cli.ts` (web server, tmux,
 * doctor, …) is neither available nor wanted there. This entry registers only the
 * `agent` verbs; `scripts/build.mjs` bundles it with its dependencies into one
 * file (`dist/remote/codeman-agent.cjs`) that runs on a bare `node`.
 *
 * @module remote-agent-cli-entry
 */
import { Command } from 'commander';
import { registerAgentCommands } from './cli-agent.js';

const program = new Command();
program
  .name('codeman')
  .description('Codeman agent CLI (remote host build: only the `agent` verbs; the server lives elsewhere)');
registerAgentCommands(program);

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
