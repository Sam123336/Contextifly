import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { ProjectGraph } from '../../types';
import { stripComments } from './dart';
import { GraphSink, discoverFiles, type Provider, type ProviderOutput } from './provider';

/**
 * Native bridge provider (beta) — the other half of Flutter platform channels.
 *
 * The Dart provider sees `MethodChannel('x').invokeMethod(...)`; this provider
 * scans the native side (android/ Kotlin+Java, ios/ Swift+Obj-C) for the code
 * that implements those channels, and links the two by the channel-name string
 * — the same "shared deterministic id" trick that joins a frontend `calls` edge
 * to a backend route handler. The joining node is `channel:<name>`, emitted by
 * both providers; a native file that constructs a channel gets a `native` node
 * and a `handles` edge into it.
 *
 * Channel-level only: one node per channel name, no per-method granularity.
 * Structural scanner (regex + same-file constant resolution), not a real AST —
 * covers idiomatic `MainActivity`/`AppDelegate` channel wiring; channel names
 * built dynamically or pulled from other files are not resolved.
 *
 * Always runs in full (no incremental support).
 */

const NATIVE_EXTS = new Set(['.kt', '.java', '.swift', '.m', '.mm']);
// Non-hidden build/dependency dirs to skip (hidden dirs are skipped by discoverFiles).
const SKIP_DIRS = new Set([
  'build', 'Pods', 'DerivedData', 'node_modules', 'captures', 'ephemeral', '.gradle', '.dart_tool',
]);
const MAX_NATIVE_FILES = 2_000;

// Channel constructors per language. Each captures the *name argument expression*
// (a string literal or an identifier we resolve against same-file constants).
const KOTLIN_JAVA = /\b(?:Method|Event|BasicMessage)Channel\s*\(\s*[^,]+,\s*([^,)]+)/g;
const SWIFT = /\bFlutter(?:Method|Event|BasicMessage)Channel\s*\(\s*name:\s*([^,)]+)/g;
const OBJC = /\b(?:method|event|basicMessage)ChannelWithName:\s*(@?"[^"]+"|[\w.]+)/g;

export const nativeProvider: Provider = {
  name: 'native',
  extract(root: string): ProviderOutput | null {
    const warnings: string[] = [];
    let nativeFiles = discoverFiles(root, NATIVE_EXTS, { skipDirs: SKIP_DIRS }).filter(
      (f) => f.rel.startsWith('android/') || f.rel.startsWith('ios/'),
    );
    if (nativeFiles.length === 0) return null;
    if (nativeFiles.length > MAX_NATIVE_FILES) {
      warnings.push(
        `Found ${nativeFiles.length} native files; scanning only the first ${MAX_NATIVE_FILES}.`,
      );
      nativeFiles = nativeFiles.slice(0, MAX_NATIVE_FILES);
    }

    const files: ProjectGraph['files'] = {};
    const sink = new GraphSink();

    for (const f of nativeFiles) {
      const rel = f.rel;
      const text = stripComments(readFileSync(f.abs, 'utf8'));
      const consts = constMap(text);
      const found: { name: string; offset: number }[] = [];
      for (const re of [KOTLIN_JAVA, SWIFT, OBJC]) {
        for (const m of text.matchAll(re)) {
          const name = resolveName(m[1], consts);
          if (name) found.push({ name, offset: m.index! });
        }
      }
      if (found.length === 0) continue; // only index native files that wire a channel

      files[rel] = { hash: f.hash };
      const framework = rel.startsWith('ios/') ? 'ios' : 'android';
      sink.addNode({ id: rel, type: 'native', name: path.basename(rel), file: rel, framework });

      const seen = new Set<string>();
      for (const { name, offset } of found) {
        const channelId = `channel:${name}`;
        sink.addNode({ id: channelId, type: 'channel', name, framework: 'flutter' });
        if (seen.has(name)) continue; // one handles edge per (file, channel)
        seen.add(name);
        sink.addEdge({
          from: rel, to: channelId, kind: 'handles',
          source: { file: rel, line: lineAt(text, offset) },
        });
      }
    }

    return { files, nodes: [...sink.nodes.values()], edges: sink.edges, warnings };
  },
};

/** Same-file string constants: `val X = "a"`, `String X = "a"`, `let X = "a"`, `X = @"a"`. */
function constMap(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of text.matchAll(/\b(\w+)\s*(?::\s*\w+\s*)?=\s*@?"([^"]+)"/g)) {
    if (!map.has(m[1])) map.set(m[1], m[2]);
  }
  return map;
}

/** A channel-name argument → its string value, or null when it can't be resolved statically. */
function resolveName(expr: string, consts: Map<string, string>): string | null {
  const s = expr.trim();
  const literal = s.match(/^@?"([^"]+)"$/);
  if (literal) return literal[1];
  if (/^[\w.]+$/.test(s)) {
    const ident = s.split('.').pop()!; // Foo.CHANNEL → CHANNEL
    return consts.get(ident) ?? null;
  }
  return null;
}

/** 1-based line of a character offset (stripComments keeps line numbers stable). */
function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}
