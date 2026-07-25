/**
 * Every tool this server exposes, with the trust class that decides whether it
 * can be pre-approved.
 *
 * This exists because a hand-maintained permission allowlist goes stale the
 * moment a version adds a tool: users who allowlisted v0.7 start getting
 * prompts again on v0.8 and have no idea why. So the list lives in one place,
 * `registerGraphTools` asserts against it at startup (a tool missing from here
 * fails loudly in development, never silently in a user's settings.json), and
 * `contextifly doctor` reports the drift between this manifest and what a
 * user's settings actually allow.
 */

export type TrustClass =
  /** Reads the repo and writes only into .pixelcontextifly/. Comparable to ripgrep or eslint. */
  | 'local'
  /** Transmits data off the machine. Stays opt-in no matter whose backend it is. */
  | 'network'
  /** Mutates source or deletes state. Never pre-approved, even locally. */
  | 'destructive';

export interface ToolSpec {
  name: string;
  trust: TrustClass;
  summary: string;
}

export const TOOLS: ToolSpec[] = [
  // --- local: repository in, .pixelcontextifly/ out -------------------------
  { name: 'index_project', trust: 'local', summary: 'Build/refresh the graph' },
  { name: 'get_project_map', trust: 'local', summary: 'Routes, component trees, API calls' },
  { name: 'search_graph', trust: 'local', summary: 'Find nodes by name' },
  { name: 'get_impact', trust: 'local', summary: 'What depends on this' },
  { name: 'trace_flow', trust: 'local', summary: 'User journey as a flow diagram' },
  { name: 'explain_visually', trust: 'local', summary: 'Mermaid dossier for a node' },
  { name: 'what_if', trust: 'local', summary: 'Simulate remove/split/lazy-load' },
  { name: 'simulate_pr', trust: 'local', summary: 'Blast radius of a whole PR' },
  { name: 'impact_across_apps', trust: 'local', summary: 'Which consumer app breaks' },
  { name: 'analyze_project', trust: 'local', summary: 'Architecture score' },
  { name: 'get_feature', trust: 'local', summary: 'Feature dossier' },
  { name: 'match_screenshot', trust: 'local', summary: 'UI element → component (text in, no upload)' },
  { name: 'blueprint_screenshot', trust: 'local', summary: 'Sketch → components (text in, no upload)' },
  { name: 'graph_diff', trust: 'local', summary: 'Architecture diff between snapshots' },
  { name: 'graph_timeline', trust: 'local', summary: 'Architecture over time' },
  { name: 'token_savings', trust: 'local', summary: 'Exploration-avoided report' },

  // --- network: leaves the machine ------------------------------------------
  { name: 'analyze_screenshot', trust: 'network', summary: 'Uploads an image to the Contextifly backend' },
  { name: 'get_screenshot', trust: 'network', summary: 'Fetches a stored analysis from the backend' },
];

/** Tool names, by trust class. */
export function toolsByTrust(trust: TrustClass): string[] {
  return TOOLS.filter((t) => t.trust === trust).map((t) => t.name);
}

/** Throws when a tool is registered that this manifest doesn't classify. */
export function assertKnownTool(name: string): void {
  if (!TOOLS.some((t) => t.name === name)) {
    throw new Error(
      `Tool "${name}" is registered but missing from src/tool-manifest.ts. ` +
        'Add it with a trust class — permissions and `contextifly doctor` are generated from that list.',
    );
  }
}

/**
 * MCP tool ids are prefixed with the server name, and the server name depends on
 * how Contextifly was installed: `.mcp.json` gives `contextifly`, the plugin
 * gives `plugin_contextifly_contextifly`. Rules are emitted for both so the
 * allowlist works either way.
 */
export const SERVER_ALIASES = ['contextifly', 'plugin_contextifly_contextifly'] as const;

export function qualify(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

export interface PermissionPlan {
  /** Pre-approved: local, non-destructive. */
  allow: string[];
  /** Always prompt: network and destructive tools, whatever else is configured. */
  ask: string[];
}

/**
 * The recommended rules.
 *
 * `explicit` (default) enumerates every tool id. Verbose, but it is the form
 * every Claude Code version understands, and the trust boundary must not depend
 * on a precedence rule we have not verified on the user's version.
 *
 * `compact` emits one server-level allow rule per alias plus per-tool `ask`
 * exclusions. Far shorter and immune to new tools going unallowed — but it
 * relies on `ask` overriding a broader `allow`, so `doctor` warns when it is in
 * place and tells the user how to confirm the network tools still prompt.
 */
export function permissionPlan(mode: 'explicit' | 'compact' = 'explicit'): PermissionPlan {
  const local = toolsByTrust('local');
  const gated = [...toolsByTrust('network'), ...toolsByTrust('destructive')];
  const allow: string[] = [];
  const ask: string[] = [];
  for (const server of SERVER_ALIASES) {
    if (mode === 'compact') {
      allow.push(`mcp__${server}`);
    } else {
      for (const tool of local) allow.push(qualify(server, tool));
    }
    for (const tool of gated) ask.push(qualify(server, tool));
  }
  return { allow, ask };
}
