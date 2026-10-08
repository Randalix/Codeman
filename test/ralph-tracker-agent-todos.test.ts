/**
 * @fileoverview Agent-set todos on the RalphTracker (`codeman agent todo`): they are
 * data, not parsed output — add/status/remove work with the tracker disabled, never
 * expire, are never evicted for a parsed todo, and come back on boot.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RalphTracker } from '../src/ralph-tracker.js';
import type { RalphTodoItem } from '../src/types.js';

describe('RalphTracker agent-set todos', () => {
  let tracker: RalphTracker;

  beforeEach(() => {
    tracker = new RalphTracker();
  });

  afterEach(() => {
    vi.useRealTimers();
    tracker.destroy();
  });

  it('adds, sets status and removes with the tracker disabled, emitting each change at once', () => {
    const updates: RalphTodoItem[][] = [];
    tracker.on('todoUpdate', (todos: RalphTodoItem[]) => updates.push(todos));
    expect(tracker.enabled).toBe(false);

    const todo = tracker.addAgentTodo('  Write   the parser  ');
    expect(todo).toMatchObject({ content: 'Write the parser', status: 'pending', source: 'agent' });
    expect(tracker.todos).toHaveLength(1);

    expect(tracker.setTodoStatus(todo!.id, 'in_progress')?.status).toBe('in_progress');
    expect(tracker.setTodoStatus(todo!.id, 'completed')?.status).toBe('completed');
    expect(tracker.setTodoStatus('todo-nope', 'completed')).toBeUndefined();

    expect(tracker.removeTodo(todo!.id)).toBe(true);
    expect(tracker.removeTodo(todo!.id)).toBe(false);
    expect(tracker.todos).toEqual([]);
    expect(updates).toHaveLength(4); // add, two status changes, remove — no debounce
    expect(tracker.enabled).toBe(false); // writing the list never switches parsing on
  });

  it('re-adding the same text re-marks the item instead of duplicating it', () => {
    const first = tracker.addAgentTodo('Ship it');
    const again = tracker.addAgentTodo('ship it!', 'in_progress', 'P0');
    expect(again?.id).toBe(first?.id);
    expect(tracker.todos).toHaveLength(1);
    expect(tracker.todos[0]).toMatchObject({ status: 'in_progress', priority: 'P0' });
  });

  it('refuses empty content', () => {
    expect(tracker.addAgentTodo('   ')).toBeNull();
    expect(tracker.todos).toEqual([]);
  });

  it('returns a copy, not the live item', () => {
    const todo = tracker.addAgentTodo('Copy check')!;
    todo.status = 'completed';
    expect(tracker.todos[0].status).toBe('pending');
  });

  it('an agent-set todo survives the expiry that drops a parsed one', () => {
    vi.useFakeTimers();
    tracker.enable();
    tracker.processTerminalData('- [ ] Parsed from the terminal\n');
    tracker.addAgentTodo('Set by the agent');
    expect(tracker.todos).toHaveLength(2);

    vi.advanceTimersByTime(2 * 60 * 60 * 1000); // past the 1 h expiry and the cleanup throttle
    tracker.processTerminalData('unrelated output\n');

    expect(tracker.todos.map((t) => t.content)).toEqual(['Set by the agent']);
  });

  it('a parsed line with the same text keeps the item agent-set', () => {
    tracker.enable();
    const todo = tracker.addAgentTodo('Fix the flaky test')!;
    tracker.processTerminalData('- [x] Fix the flaky test\n');
    expect(tracker.todos).toHaveLength(1);
    expect(tracker.todos[0]).toMatchObject({ id: todo.id, status: 'completed', source: 'agent' });
  });

  it('a full list evicts parsed todos for agent ones, never the other way round', () => {
    tracker.setMaxTodos(2);
    tracker.enable();
    tracker.processTerminalData('- [ ] Parsed item number one\n');
    tracker.addAgentTodo('Agent item one');
    expect(tracker.addAgentTodo('Agent item two')).not.toBeNull(); // evicts the parsed one
    expect(tracker.todos.every((t) => t.source === 'agent')).toBe(true);

    tracker.processTerminalData('- [ ] Parsed item number two\n'); // no room: dropped, nothing evicted
    expect(tracker.todos.map((t) => t.content)).toEqual(['Agent item one', 'Agent item two']);

    expect(tracker.addAgentTodo('Agent item three')).toBeNull(); // full of agent todos: refuse
    expect(tracker.todos).toHaveLength(2);
  });

  it('restoreAgentTodos brings back only agent-set items, keeps present ones, and does not emit', () => {
    const emitted = vi.fn();
    tracker.on('todoUpdate', emitted);
    const stored: RalphTodoItem[] = [
      { id: 'todo-a', content: 'Agent A', status: 'in_progress', detectedAt: 1, priority: null, source: 'agent' },
      { id: 'todo-b', content: 'Parsed B', status: 'pending', detectedAt: 1, priority: null },
    ];
    expect(tracker.restoreAgentTodos(stored)).toBe(1);
    expect(tracker.restoreAgentTodos(stored)).toBe(0);
    expect(tracker.todos).toEqual([stored[0]]);
    expect(emitted).not.toHaveBeenCalled();
  });
});
