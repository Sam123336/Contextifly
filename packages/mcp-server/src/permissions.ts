/**
 * Permission installer + doctor.
 *
 * People run one command; they do not copy JSON. So the recommended allowlist is
 * computed from `tool-manifest.ts`, merged into the user's settings without
 * disturbing anything else, and verified afterwards — with the network tools
 * deliberately left prompting.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { permissionPlan, TOOLS, toolsByTrust, type PermissionPlan } from './tool-manifest';

export type Scope = 'user' | 'project';

interface Settings {
  permissions?: { allow?: string[]; ask?: string[]; deny?: string[] };
  enabledMcpjsonServers?: string[];
  [key: string]: unknown;
}

export function settingsPath(scope: Scope, projectDir: string): string {
  return scope === 'user'
    ? path.join(homedir(), '.claude', 'settings.json')
    : path.join(path.resolve(projectDir), '.claude', 'settings.json');
}

function readSettings(file: string): Settings {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Settings;
  } catch (err) {
    throw new Error(
      `${file} is not valid JSON (${err instanceof Error ? err.message : String(err)}). ` +
        'A malformed settings file silently disables every setting in it — fix it before installing.',
    );
  }
}

export interface PermissionDiff {
  file: string;
  missingAllow: string[];
  missingAsk: string[];
  /** Network/destructive tools sitting in `allow` — the trust boundary is broken. */
  overAllowed: string[];
  /** A server-level allow rule is present, so future tools are auto-approved too. */
  compactRules: string[];
}

export function diffPermissions(file: string, plan: PermissionPlan): PermissionDiff {
  const settings = readSettings(file);
  const allow = new Set(settings.permissions?.allow ?? []);
  const ask = new Set(settings.permissions?.ask ?? []);
  const deny = new Set(settings.permissions?.deny ?? []);

  const compactRules = [...allow].filter((r) => /^mcp__[^_]+(_[^_]+)*$/.test(r) && !r.includes('__', 5));
  const covered = (rule: string) => {
    if (allow.has(rule)) return true;
    // A server-level rule covers every tool on that server.
    const server = rule.split('__')[1];
    return allow.has(`mcp__${server}`);
  };

  const gated = new Set([...toolsByTrust('network'), ...toolsByTrust('destructive')]);
  const overAllowed = [...allow].filter((r) => {
    const tool = r.split('__').slice(2).join('__');
    return gated.has(tool);
  });

  return {
    file,
    missingAllow: plan.allow.filter((r) => !covered(r)),
    // An explicitly denied tool is already gated harder than "ask".
    missingAsk: plan.ask.filter((r) => !ask.has(r) && !deny.has(r)),
    overAllowed,
    compactRules,
  };
}

export interface InstallResult extends PermissionDiff {
  added: number;
  created: boolean;
}

/** Merge the plan into a settings file. Never replaces arrays, never touches other keys. */
export function installPermissions(
  scope: Scope,
  projectDir: string,
  plan: PermissionPlan,
  opts: { enableMcpServer?: boolean } = {},
): InstallResult {
  const file = settingsPath(scope, projectDir);
  const before = diffPermissions(file, plan);
  const created = !existsSync(file);
  const settings = readSettings(file);

  settings.permissions ??= {};
  settings.permissions.allow = [...(settings.permissions.allow ?? []), ...before.missingAllow];
  if (before.missingAsk.length > 0) {
    settings.permissions.ask = [...(settings.permissions.ask ?? []), ...before.missingAsk];
  }
  if (opts.enableMcpServer && scope === 'project') {
    const servers = new Set(settings.enabledMcpjsonServers ?? []);
    servers.add('contextifly');
    settings.enabledMcpjsonServers = [...servers];
  }

  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');

  return {
    ...before,
    added: before.missingAllow.length + before.missingAsk.length,
    created,
  };
}

// --- doctor -----------------------------------------------------------------

const OK = '✓';
const WARN = '⚠';

export interface DoctorInput {
  projectDir: string;
  /** Present when the project has an indexed graph. */
  graph: { version: number; nodes: number; edges: number; indexedAt: string } | null;
  staleFiles: number | null;
}

/**
 * Health report: is Claude Code here, is the graph usable, and are the
 * permissions in a state where the local tools run without prompting while the
 * network tools still ask?
 */
export function renderDoctor(input: DoctorInput, mode: 'explicit' | 'compact' = 'explicit'): string {
  const plan = permissionPlan(mode);
  const lines: string[] = ['Contextifly doctor', ''];
  let problems = 0;

  const claudeDir = path.join(homedir(), '.claude');
  const hasClaude = existsSync(claudeDir);
  lines.push(
    hasClaude
      ? `${OK} Claude Code detected — ${claudeDir}`
      : `${WARN} Claude Code not detected (no ${claudeDir}) — permissions setup is a no-op until it is installed`,
  );
  if (!hasClaude) problems++;

  if (input.graph) {
    lines.push(
      `${OK} Graph cache healthy — ${input.graph.nodes} nodes, ${input.graph.edges} edges ` +
        `(indexed ${input.graph.indexedAt.slice(0, 19).replace('T', ' ')})`,
      input.graph.version === 2
        ? `${OK} Graph version matches (v${input.graph.version})`
        : `${WARN} Graph version v${input.graph.version} is stale — run \`contextifly index .\``,
    );
    if (input.graph.version !== 2) problems++;
    if (input.staleFiles && input.staleFiles > 0) {
      lines.push(`${WARN} ${input.staleFiles} file(s) changed since indexing — the next query auto-refreshes`);
    }
  } else {
    lines.push(`${WARN} No graph yet for ${input.projectDir} — run \`contextifly index .\``);
    problems++;
  }

  lines.push('');
  // Claude Code merges allow rules across user → project, so a tool is covered
  // when EITHER scope allows it. Reporting per-scope gaps as problems would
  // nag a user who set it up globally, which is the setup we recommend.
  const perScope = (['user', 'project'] as const).map((scope) => ({
    scope,
    file: settingsPath(scope, input.projectDir),
    diff: diffPermissions(settingsPath(scope, input.projectDir), plan),
  }));
  const covered = new Set(perScope.flatMap((s) => plan.allow.filter((r) => !s.diff.missingAllow.includes(r))));
  const uncovered = plan.allow.filter((r) => !covered.has(r));

  for (const { scope, file, diff } of perScope) {
    const label = scope === 'user' ? 'User settings ' : 'Project settings';
    if (!existsSync(file)) {
      lines.push(`  ${label} — not present (${file})`);
      continue;
    }
    const have = plan.allow.length - diff.missingAllow.length;
    lines.push(`  ${label} — ${have}/${plan.allow.length} tool rule(s)`);
    if (diff.overAllowed.length > 0) {
      problems += 1;
      lines.push(
        `${WARN} ${label} — network tool(s) pre-approved: ${diff.overAllowed.join(', ')}`,
        '      These upload data. Move them out of "allow" unless that is deliberate.',
      );
    }
    if (diff.compactRules.length > 0) {
      lines.push(
        `${WARN} ${label} — server-level rule(s) present: ${diff.compactRules.join(', ')}`,
        '      This allows every current AND future tool on that server. Confirm the network',
        '      tools still prompt on your Claude Code version before relying on it.',
      );
    }
  }

  if (uncovered.length === 0) {
    lines.push(`${OK} Permissions — every local tool is pre-approved in at least one scope`);
  } else {
    problems++;
    lines.push(`${WARN} Missing permissions — ${uncovered.length} local tool(s) will prompt:`);
    for (const rule of uncovered.slice(0, 8)) lines.push(`      ${rule}`);
    if (uncovered.length > 8) lines.push(`      …and ${uncovered.length - 8} more`);
  }

  lines.push('');
  const network = toolsByTrust('network');
  // Derived, never asserted: claiming the network tools are gated while a rule
  // says otherwise would be the one lie that matters in this report.
  const anyOverAllowed = perScope.some((s) => s.diff.overAllowed.length > 0);
  lines.push(
    anyOverAllowed
      ? `${WARN} Network tools are NOT fully gated — see the pre-approved rule(s) above`
      : `${OK} Screenshot tools left unapproved — ${network.join(', ')} (they upload data)`,
    '',
  );

  if (problems > 0) {
    lines.push('Run:', '', '  contextifly permissions install', '');
  } else {
    lines.push('Everything looks good.', '');
  }

  lines.push(
    `Tools: ${toolsByTrust('local').length} local · ${network.length} network · ${TOOLS.length} total`,
  );
  return lines.join('\n');
}

export function renderInstallResult(result: InstallResult, scope: Scope): string {
  const lines: string[] = [];
  lines.push(`${OK} Claude Code settings: ${result.file}${result.created ? ' (created)' : ''}`);
  if (result.added === 0) {
    lines.push(`${OK} Already up to date — nothing to add`);
  } else {
    lines.push(
      `${OK} Added ${result.missingAllow.length} allow rule(s) for local tools`,
      result.missingAsk.length > 0
        ? `${OK} Added ${result.missingAsk.length} ask rule(s) so network tools keep prompting`
        : `${OK} Network tools already gated`,
    );
  }
  lines.push(
    `${OK} Screenshot tools left unapproved — ${toolsByTrust('network').join(', ')}`,
    '',
    scope === 'user'
      ? 'Applies to every project on this machine. Restart Claude Code to load it.'
      : 'Applies to this project. Restart Claude Code to load it.',
    '',
    'Verify with: contextifly doctor',
  );
  return lines.join('\n');
}
