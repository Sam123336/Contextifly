/** Change over time: diff between two graph snapshots, and the full timeline. */

import type { GraphNode, ProjectGraph } from '../types';

export function renderGraphDiff(before: ProjectGraph, after: ProjectGraph): string {
  const lines: string[] = ['# Architecture diff', ''];
  const label = (g: ProjectGraph) =>
    `${g.indexedAt}${g.commit ? ` (commit ${g.commit.slice(0, 7)})` : ''}`;
  lines.push(`**From:** ${label(before)}  \n**To:** ${label(after)}`, '');

  const beforeIds = new Map(before.nodes.map((n) => [n.id, n]));
  const afterIds = new Map(after.nodes.map((n) => [n.id, n]));
  const added = after.nodes.filter((n) => !beforeIds.has(n.id));
  const removed = before.nodes.filter((n) => !afterIds.has(n.id));

  for (const [title, list] of [
    ['Added', added],
    ['Removed', removed],
  ] as const) {
    if (list.length === 0) continue;
    lines.push(`## ${title}`);
    for (const type of [
      'route', 'component', 'hook', 'context', 'api',
      'controller', 'service', 'module', 'entity', 'file',
    ] as const) {
      const ofType = list.filter((n) => n.type === type);
      if (ofType.length === 0) continue;
      lines.push(`- **${type}s:** ${ofType.map((n) => `\`${n.name}\``).join(', ')}`);
    }
    lines.push('');
  }
  if (added.length === 0 && removed.length === 0) {
    lines.push('_No nodes added or removed._', '');
  }

  // Coupling movement: nodes whose degree changed the most between versions.
  const degree = (g: ProjectGraph) => {
    const d = new Map<string, number>();
    for (const e of g.edges) {
      d.set(e.from, (d.get(e.from) ?? 0) + 1);
      d.set(e.to, (d.get(e.to) ?? 0) + 1);
    }
    return d;
  };
  const dBefore = degree(before);
  const dAfter = degree(after);
  const movers = [...afterIds.values()]
    .filter((n) => n.type === 'component' && beforeIds.has(n.id))
    .map((n) => ({ n, delta: (dAfter.get(n.id) ?? 0) - (dBefore.get(n.id) ?? 0) }))
    .filter((m) => m.delta !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 8);
  if (movers.length > 0) {
    lines.push('## Coupling changes');
    for (const { n, delta } of movers) {
      lines.push(
        `- \`${n.name}\` ${delta > 0 ? 'gained' : 'lost'} ${Math.abs(delta)} connection(s)`,
      );
    }
    lines.push('');
  }

  const edgeDelta = after.edges.length - before.edges.length;
  lines.push(
    `**Totals:** ${after.nodes.length} nodes (${signed(after.nodes.length - before.nodes.length)}), ` +
      `${after.edges.length} edges (${signed(edgeDelta)})`,
  );
  return lines.join('\n');
}

function signed(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}

/**
 * Architecture timeline: chronological evolution across snapshots (oldest →
 * current). Each step condenses the diff to what a developer would say in
 * standup: "added checkout flow, removed legacy banner".
 */
export function renderTimeline(history: ProjectGraph[]): string {
  if (history.length < 2) {
    return (
      '# Architecture timeline\n\n_Only one graph version exists so far. ' +
      'Snapshots accumulate automatically as the code changes and gets re-indexed._'
    );
  }
  const lines: string[] = ['# Architecture timeline', ''];
  for (let i = 1; i < history.length; i++) {
    const before = history[i - 1];
    const after = history[i];
    const date = after.indexedAt.slice(0, 10);
    const commit = after.commit ? ` · ${after.commit.slice(0, 7)}` : '';
    lines.push(`## ${date}${commit}${i === history.length - 1 ? ' (current)' : ''}`);

    const beforeIds = new Set(before.nodes.map((n) => n.id));
    const afterIds = new Set(after.nodes.map((n) => n.id));
    const added = after.nodes.filter((n) => !beforeIds.has(n.id));
    const removed = before.nodes.filter((n) => !afterIds.has(n.id));
    const summarize = (list: GraphNode[], verb: string) => {
      for (const type of [
        'route', 'component', 'context', 'hook', 'api',
        'controller', 'service', 'module', 'entity',
      ] as const) {
        const ofType = list.filter((n) => n.type === type);
        if (ofType.length === 0) continue;
        const names = ofType.slice(0, 4).map((n) => `\`${n.name}\``).join(', ');
        const more = ofType.length > 4 ? ` +${ofType.length - 4} more` : '';
        lines.push(`- ${verb} ${type}${ofType.length > 1 ? 's' : ''}: ${names}${more}`);
      }
    };
    summarize(added, 'Added');
    summarize(removed, 'Removed');
    const edgeDelta = after.edges.length - before.edges.length;
    if (added.length === 0 && removed.length === 0) {
      lines.push(`- Structure unchanged (${signed(edgeDelta)} edges)`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
