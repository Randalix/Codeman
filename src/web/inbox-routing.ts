/**
 * @fileoverview Downstream (Randalix fork): who should get a post instead of the
 * coordinator. `~/.codeman/routing.json` maps sessions to their lead:
 *
 *   { "koordinator": "8d68980d", "lead_of": { "<session>": "<lead>" } }
 *
 * Ids are full session ids or prefixes of at least 8 characters. A post from a session
 * with a lead to the coordinator is still delivered; the inbox route only adds
 * `routing: { lead }` to its answer and the CLI prints a hint (`--direct` skips it).
 * The check runs on the server because remote workers run their CLI on another host
 * and cannot read this file.
 *
 * The file is read on every post (it is tiny, and an edit needs no restart). A missing
 * or broken file means no routing: the post goes through as before.
 *
 * @module web/inbox-routing
 */

import { readFileSync } from 'node:fs';
import { dataPath } from '../config/instance.js';

export interface InboxRouting {
  coordinator: string;
  leadOf: Record<string, string>;
}

/** Shorter prefixes would match too many sessions. */
const MIN_PREFIX = 8;

/** Same session: equal, or one is a prefix (≥ 8 chars) of the other. */
export function sameSession(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= MIN_PREFIX && long.startsWith(short);
}

/** Parse the file's JSON; null when it does not have the expected shape. */
export function parseInboxRouting(raw: unknown): InboxRouting | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const coordinator = obj.koordinator ?? obj.coordinator;
  const leadOf = obj.lead_of;
  if (typeof coordinator !== 'string' || coordinator.length === 0) return null;
  if (!leadOf || typeof leadOf !== 'object' || Array.isArray(leadOf)) return null;
  const map: Record<string, string> = {};
  for (const [session, lead] of Object.entries(leadOf as Record<string, unknown>)) {
    if (typeof lead === 'string' && lead.length > 0 && session.length > 0) map[session] = lead;
  }
  return { coordinator, leadOf: map };
}

export function loadInboxRouting(path: string = dataPath('routing.json')): InboxRouting | null {
  try {
    return parseInboxRouting(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

/**
 * The lead a post from `from` to `to` should have gone to, or null. Only posts to the
 * coordinator from a session that has a lead count; a lead posting to the coordinator
 * itself, or a session whose lead IS the coordinator, gets no hint.
 */
export function routingLeadFor(routing: InboxRouting | null, from: string | null, to: string): string | null {
  if (!routing || !from) return null;
  if (!sameSession(to, routing.coordinator)) return null;
  const entry = Object.entries(routing.leadOf).find(([session]) => sameSession(session, from));
  if (!entry) return null;
  const lead = entry[1];
  if (sameSession(lead, routing.coordinator) || sameSession(lead, from)) return null;
  return lead;
}
