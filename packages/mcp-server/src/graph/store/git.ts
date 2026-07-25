import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { graphDir } from './graph-store';

const GIT_STATE_FILE = 'git-state.json';

/**
 * The repository's git position at the moment the graph was built, persisted
 * next to graph.json in <project>/.pixelcontextifly/git-state.json. A later run
 * reads it back and decides — from git alone, without re-parsing the project —
 * whether the stored graph is still valid.
 *
 * HEAD shas ARE the git-history fingerprint: any commit, amend, rebase, merge,
 * or branch switch moves one of them, so comparing shas is the same as matching
 * `git log`. The main/master head is tracked separately so the graph refreshes
 * when the main line advances even while you sit on a feature branch.
 */
export interface GitState {
  /** Current branch, or 'HEAD' when detached. */
  branch: string;
  /** HEAD commit of the current branch. */
  head: string;
  /** Default branch name if it exists locally ('main' or 'master'), else null. */
  mainBranch: string | null;
  /** HEAD commit of the tracked main/master branch. */
  mainHead: string | null;
}

function git(root: string, args: string[]): string | null {
  try {
    // execFile, not a shell string: paths and refs may contain spaces or globs.
    return execFileSync('git', args, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 32 * 1024 * 1024,
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

/** Current HEAD commit sha, or undefined outside a git repo. */
export function gitHead(root: string): string | undefined {
  return git(root, ['rev-parse', 'HEAD']) ?? undefined;
}

/** Read the live git position, or null when root is not a git repo / has no commits. */
export function readGitState(root: string): GitState | null {
  const head = git(root, ['rev-parse', 'HEAD']);
  if (!head) return null;
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']) ?? 'HEAD';
  let mainBranch: string | null = null;
  for (const cand of ['main', 'master']) {
    if (git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${cand}`])) {
      mainBranch = cand;
      break;
    }
  }
  const mainHead = mainBranch ? git(root, ['rev-parse', mainBranch]) : null;
  return { branch, head, mainBranch, mainHead };
}

function stateFile(root: string): string {
  return path.join(graphDir(root), GIT_STATE_FILE);
}

export function loadGitState(root: string): GitState | null {
  const file = stateFile(root);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as GitState;
  } catch {
    return null; // corrupt sidecar: treat as absent, a rebuild will rewrite it.
  }
}

/** Persist the sidecar. graphDir already exists (saveGraph ran, or a graph was loaded). */
export function saveGitState(root: string, state: GitState): void {
  writeFileSync(stateFile(root), JSON.stringify(state, null, 2) + '\n');
}

function equal(a: GitState | null, b: GitState | null): boolean {
  if (!a || !b) return false;
  return a.branch === b.branch && a.head === b.head && a.mainHead === b.mainHead;
}

/**
 * Write the sidecar only when it is missing or no longer matches — so a plain
 * reuse never rewrites a file, but a graph indexed before git tracking existed
 * still gets upgraded to a sidecar the first time it is served.
 */
export function ensureGitState(root: string, saved: GitState | null, current: GitState | null): void {
  if (current && !equal(saved, current)) saveGitState(root, current);
}

// --- PR / fleet support -----------------------------------------------------

/** Resolve a ref (branch, tag, sha) to a full sha, or null when it does not exist. */
export function revParse(root: string, ref: string): string | null {
  return git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
}

/**
 * Files a PR touches: the three-dot diff (base...head) — changes on head since
 * it forked from base, which is exactly what a PR shows and excludes commits
 * that landed on base in the meantime.
 */
export function changedFiles(root: string, base: string, head: string): string[] {
  const out = git(root, ['diff', '--name-only', `${base}...${head}`]);
  return out ? out.split('\n').filter(Boolean) : [];
}

/** Files touched by a unified diff, read from its `+++ b/<path>` headers. */
export function patchFiles(patch: string): string[] {
  const files = new Set<string>();
  for (const m of patch.matchAll(/^\+\+\+ (?:b\/)?(.+)$/gm)) {
    const file = m[1].trim();
    if (file && file !== '/dev/null') files.add(file);
  }
  return [...files];
}

/**
 * Days since a file's last commit, or null when git has no record of it.
 * The age signal behind "this PR just wired traffic into code nobody has
 * touched in a year".
 */
export function lastCommitDays(root: string, file: string, now = Date.now()): number | null {
  const ts = git(root, ['log', '-1', '--format=%ct', '--', file]);
  if (!ts) return null;
  const seconds = Number(ts.split('\n')[0]);
  if (!Number.isFinite(seconds)) return null;
  return Math.floor((now - seconds * 1000) / 86_400_000);
}

/**
 * Run `fn` against a detached worktree checked out at `ref`, then clean up.
 * Non-destructive by construction: the developer's own checkout, branch, and
 * uncommitted work are never touched — this is what lets us index the "after"
 * side of a PR, or a consumer app's master, while you keep working.
 */
export function withWorktree<T>(root: string, ref: string, fn: (dir: string) => T): T {
  const parent = mkdtempSync(path.join(tmpdir(), 'contextifly-wt-'));
  const dir = path.join(parent, 'tree'); // git requires a non-existent path
  const added = git(root, ['worktree', 'add', '--detach', '--force', dir, ref]);
  if (added === null) {
    rmSync(parent, { recursive: true, force: true });
    throw new Error(`Could not create a git worktree at \`${ref}\` — does that ref exist?`);
  }
  try {
    return fn(dir);
  } finally {
    git(root, ['worktree', 'remove', '--force', dir]);
    rmSync(parent, { recursive: true, force: true });
  }
}

/** True when the working tree has uncommitted changes — or when git can't say. */
export function isDirty(root: string): boolean {
  const out = git(root, ['status', '--porcelain']);
  return out === null ? true : out.length > 0; // unknown → never serve a cached graph
}

/** A file's exact content at a ref, without checking anything out. */
export function showFile(root: string, ref: string, file: string): string | null {
  return git(root, ['show', `${ref}:${file}`]);
}

/** Apply a unified diff inside a worktree. Throws with git's own reason on conflict. */
export function applyPatch(dir: string, patchFile: string): void {
  const ok = git(dir, ['apply', '--3way', '--whitespace=nowarn', patchFile]);
  if (ok === null) {
    throw new Error(
      `\`git apply\` failed for ${path.basename(patchFile)} — the patch does not apply cleanly ` +
        'to the base commit. Re-export it against the current base, or pass a branch/sha instead.',
    );
  }
}

/**
 * Why git says the graph is out of date, or null when git reports no change.
 * Returns null when git can't be consulted (non-repo, or no prior sidecar) so
 * callers fall back to file-hash staleness.
 */
export function gitDrift(saved: GitState | null, current: GitState | null): string | null {
  if (!saved || !current) return null;
  if (saved.branch !== current.branch) {
    return `switched branch \`${saved.branch}\` → \`${current.branch}\``;
  }
  if (saved.head !== current.head) {
    return `\`${current.branch}\` moved to \`${current.head.slice(0, 7)}\``;
  }
  if (saved.mainHead !== current.mainHead) {
    const name = current.mainBranch ?? 'main';
    return `\`${name}\` advanced to \`${(current.mainHead ?? '').slice(0, 7)}\``;
  }
  return null;
}
