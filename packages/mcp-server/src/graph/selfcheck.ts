/**
 * Self-check for the two pieces of the fleet/PR simulator that are heuristic
 * and therefore worth pinning down: the cross-repo endpoint join, and the
 * unguarded-dereference sniff. Everything else is graph traversal or git.
 *
 *   node dist/graph/selfcheck.js
 */

import assert from 'node:assert/strict';
import { endpointMatch, parseApiId, pathShape, toEndpoint } from './analyze/endpoints';
import { patchFiles } from './store/git';
import { firstUnguardedChain } from './analyze/pr-simulation';
import {
  assertKnownTool,
  permissionPlan,
  SERVER_ALIASES,
  TOOLS,
  toolsByTrust,
} from '../tool-manifest';

function checkPathShape(): void {
  // The three spellings of the same endpoint, one per provider.
  assert.equal(pathShape('/orders/:id'), '/orders/*'); // nestjs
  assert.equal(pathShape('/orders/$orderId'), '/orders/*'); // dart
  assert.equal(pathShape('/orders/${order.id}'), '/orders/*'); // web
  assert.equal(pathShape('/orders/[id]'), '/orders/*'); // next
  assert.equal(pathShape('/orders/1042'), '/orders/*'); // substituted value
  assert.equal(pathShape('/orders/507f1f77bcf86cd799439011'), '/orders/*'); // objectid

  // Static segments stay literal — the join must not collapse everything.
  assert.equal(pathShape('/orders/status'), '/orders/status');
  assert.notEqual(pathShape('/orders/status'), pathShape('/orders/summary'));

  assert.equal(pathShape('https://api.example.com/v1/orders/7?full=1'), '/v1/orders/*');
  assert.equal(pathShape('/api/orders/:id', ['/api']), '/orders/*');
  assert.equal(pathShape('/apiary/orders'), '/apiary/orders'); // prefix strip is segment-aligned
  assert.equal(pathShape('/'), '/');
}

function checkEndpointMatch(): void {
  const declared = toEndpoint('GET', '/orders/:id');

  const dart = endpointMatch(declared, toEndpoint('GET', '/orders/$orderId'));
  assert.equal(dart.matched, true);
  assert.equal(dart.confidence, 1);

  // Wrong verb is not the same endpoint.
  assert.equal(endpointMatch(declared, toEndpoint('POST', '/orders/$id')).matched, false);
  // Different resource is not the same endpoint.
  assert.equal(endpointMatch(declared, toEndpoint('GET', '/invoices/$id')).matched, false);
  // Extra path depth is not the same endpoint.
  assert.equal(endpointMatch(declared, toEndpoint('GET', '/orders/$id/items')).matched, false);

  // Un-configured mount prefix: matched, but demoted and explained.
  const prefixed = endpointMatch(declared, toEndpoint('GET', '/api/v1/orders/$id'));
  assert.equal(prefixed.matched, true);
  assert.equal(prefixed.confidence, 0.6);
  assert.match(prefixed.reason ?? '', /basePath/);

  // Next.js route handlers are verb-agnostic on the declaring side.
  assert.equal(endpointMatch(toEndpoint('ROUTE', '/orders/:id'), toEndpoint('DELETE', '/orders/9')).matched, true);

  assert.deepEqual(parseApiId('api:GET /orders/:id'), { method: 'GET', url: '/orders/:id' });
  assert.equal(parseApiId('route:/orders'), null);
}

function checkGuardSniff(): void {
  // Yesterday's crash: response used two levels deep with no optional chaining.
  const crashes = ['const res = await api.get(url);', 'setState(res.data.orderState);'];
  assert.equal(firstUnguardedChain(crashes, 1), 'res.data.orderState (line 2)');

  // Guarded anywhere in the chain short-circuits the whole thing.
  assert.equal(firstUnguardedChain(['const r = await api.get(u);', 'go(r?.data.orderState);'], 1), undefined);
  assert.equal(firstUnguardedChain(['const r = await api.get(u);', 'go(r.data?.orderState);'], 1), undefined);

  // Known globals are not response objects.
  assert.equal(firstUnguardedChain(['api.get(u);', 'console.log.call(x);'], 1), undefined);
  // Types/namespaces/enums resolve at compile time and cannot be null.
  assert.equal(firstUnguardedChain(['api.get(u);', 'file: Express.Multer.File,'], 1), undefined);
  assert.equal(firstUnguardedChain(['api.get(u);', 'if (s === OrderStatus.Pending.code) {'], 1), undefined);
  // Comments are not code.
  assert.equal(firstUnguardedChain(['api.get(u);', '// res.data.orderState'], 1), undefined);
  // Nothing within the window.
  assert.equal(firstUnguardedChain(['api.get(u);', 'return null;'], 1), undefined);
}

function checkPatchFiles(): void {
  const patch = [
    'diff --git a/src/orders.service.ts b/src/orders.service.ts',
    '--- a/src/orders.service.ts',
    '+++ b/src/orders.service.ts',
    '@@ -1 +1 @@',
    '-const a = 1;',
    '+const a = 2;',
    'diff --git a/src/gone.ts b/src/gone.ts',
    '--- a/src/gone.ts',
    '+++ /dev/null',
  ].join('\n');
  assert.deepEqual(patchFiles(patch), ['src/orders.service.ts']);
}

function checkPermissionPlan(): void {
  const explicit = permissionPlan('explicit');
  const compact = permissionPlan('compact');
  const network = toolsByTrust('network');
  assert.ok(network.length > 0, 'network tools must exist for this check to mean anything');

  // The trust boundary: no network tool may ever land in `allow`, in either mode.
  for (const plan of [explicit, compact]) {
    for (const tool of network) {
      assert.ok(
        !plan.allow.some((rule) => rule.endsWith(`__${tool}`)),
        `${tool} must never be pre-approved — it leaves the machine`,
      );
      assert.ok(
        plan.ask.some((rule) => rule.endsWith(`__${tool}`)),
        `${tool} must be in "ask" so it keeps prompting`,
      );
    }
  }

  // Both install paths are covered, so the allowlist works however it was installed.
  for (const server of SERVER_ALIASES) {
    assert.ok(explicit.allow.some((r) => r.startsWith(`mcp__${server}__`)), `missing rules for ${server}`);
  }
  assert.equal(explicit.allow.length, toolsByTrust('local').length * SERVER_ALIASES.length);
  assert.equal(compact.allow.length, SERVER_ALIASES.length);

  // Every tool is classified — an unclassified tool would silently miss the allowlist.
  assert.equal(TOOLS.length, toolsByTrust('local').length + network.length + toolsByTrust('destructive').length);
  assert.equal(new Set(TOOLS.map((t) => t.name)).size, TOOLS.length, 'duplicate tool in the manifest');
  assertKnownTool('simulate_pr');
  assert.throws(() => assertKnownTool('not_a_real_tool'), /missing from src\/tool-manifest/);
}

const checks = [checkPathShape, checkEndpointMatch, checkGuardSniff, checkPatchFiles, checkPermissionPlan];
for (const check of checks) {
  check();
  console.log(`✓ ${check.name}`);
}
console.log(`\n${checks.length} checks passed.`);
