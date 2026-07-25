import type { GraphNode, NodeType, SemanticRole } from '../types';

/**
 * Normalizer: assigns framework-agnostic semantic roles on top of the
 * syntax-level node types emitted by providers.
 *
 * Rules here must be deterministic and unambiguous — a wrong role misleads
 * every downstream consumer. Roles that cannot be derived with certainty
 * are left unset rather than guessed. The role never replaces the concrete
 * `type`; algorithms that need precision keep reading `type`.
 */
const ROLE_BY_TYPE: Partial<Record<NodeType, SemanticRole>> = {
  route: 'entry-point',
  controller: 'entry-point',
  api: 'http-boundary',
  service: 'business-logic',
  module: 'composition-root',
  entity: 'data-model',
  context: 'state',
};

export function normalize(nodes: Iterable<GraphNode>): void {
  for (const node of nodes) {
    if (node.role) continue;
    const role = ROLE_BY_TYPE[node.type];
    if (role) node.role = role;
  }
}
