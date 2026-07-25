/**
 * Endpoint identity — the only symbol a NestJS controller, a Dart `http.get`
 * and a web `fetch()` have in common.
 *
 * Inside one repo, coupling is imports and the AST sees it. Across repos there
 * is no AST link at all: the backend and the customer app share zero symbols.
 * They share a URL. So the fleet is joined here, on `api:METHOD /path` node ids
 * that every provider already emits (nestjs.ts, dart.ts, frontend.ts).
 *
 * The join is exact on static segments and heuristic on parameterised ones —
 * `/orders/:id` (declared), `/orders/$orderId` (Dart) and `/orders/${id}` (web)
 * are the same endpoint, and nothing in the source says so. Every match carries
 * its confidence so the report can tell you which lines to trust.
 */

export interface Endpoint {
  /** Upper-case HTTP verb, or 'ROUTE' for Next.js route handlers (verb-agnostic). */
  method: string;
  /** Path with every parameterised segment collapsed to `*`. */
  shape: string;
  /** The path exactly as it appeared in source. */
  raw: string;
}

export interface EndpointMatch {
  matched: boolean;
  /** 1 = identical shape; below 1 = matched with a caveat named in `reason`. */
  confidence: number;
  reason?: string;
}

/** Parse an `api:GET /orders/:id` node id. Returns null for anything else. */
export function parseApiId(id: string): { method: string; url: string } | null {
  if (!id.startsWith('api:')) return null;
  const rest = id.slice('api:'.length);
  const sep = rest.indexOf(' ');
  if (sep < 0) return null;
  return { method: rest.slice(0, sep).toUpperCase(), url: rest.slice(sep + 1) };
}

/**
 * A path segment is a *parameter* when it cannot be compared literally across
 * repos: `:id`, `{id}`, `<id>`, `[id]` (Next.js), `$id` / `${order.id}`
 * (Dart & JS interpolation), or a value already substituted in — a number, or a
 * uuid/hex/objectid-shaped token someone pasted into an example URL.
 */
function isParamSegment(seg: string): boolean {
  if (seg.length === 0) return false;
  if (/^[:{[<]/.test(seg)) return true;
  if (seg.includes('$')) return true; // $id, ${order.id}, order-$id
  if (/^\d+$/.test(seg)) return true;
  if (/^[0-9a-f]{8,}$/i.test(seg)) return true; // uuid / objectid / hex token
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(seg)) return true;
  return false;
}

/**
 * Normalise a URL path to its comparable shape: `/orders/${id}/items` → `/orders/&#42;/items`.
 * `stripPrefixes` removes a known mount prefix (a Nest global prefix, an app's
 * configured base path) before comparison.
 */
export function pathShape(url: string, stripPrefixes: string[] = []): string {
  let p = url.split(/[?#]/)[0].trim();
  // Absolute URL from an app's base-url constant: keep only the pathname.
  const scheme = p.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]*(\/.*)?$/i);
  if (scheme) p = scheme[1] ?? '/';
  for (const prefix of stripPrefixes) {
    const clean = '/' + prefix.split('/').filter(Boolean).join('/');
    if (clean !== '/' && (p === clean || p.startsWith(clean + '/'))) {
      p = p.slice(clean.length) || '/';
      break;
    }
  }
  const segments = p.split('/').filter(Boolean).map((s) => (isParamSegment(s) ? '*' : s));
  return '/' + segments.join('/');
}

export function toEndpoint(method: string, url: string, stripPrefixes: string[] = []): Endpoint {
  return { method: method.toUpperCase(), shape: pathShape(url, stripPrefixes), raw: url };
}

/** Verbs match when equal, or when either side is a verb-agnostic route handler. */
function methodsMatch(a: string, b: string): boolean {
  return a === b || a === 'ROUTE' || b === 'ROUTE';
}

/**
 * Do a declared endpoint and a called endpoint refer to the same thing?
 *
 * Exact shape → 1.0. Otherwise one shape being a segment-aligned suffix of the
 * other → 0.6: the usual cause is an un-configured mount prefix (`/api/orders/*`
 * called, `/orders/*` declared), and the usual cure is setting `basePath` in the
 * workspace config. Reported, never silently trusted.
 */
export function endpointMatch(declared: Endpoint, called: Endpoint): EndpointMatch {
  const NO: EndpointMatch = { matched: false, confidence: 0 };
  if (!methodsMatch(declared.method, called.method)) return NO;
  if (declared.shape === called.shape) return { matched: true, confidence: 1 };

  const d = declared.shape.split('/').filter(Boolean);
  const c = called.shape.split('/').filter(Boolean);
  const alignsAt = (short: string[], long: string[], offset: number) =>
    short.every((s, i) => s === long[offset + i] || s === '*' || long[offset + i] === '*');

  // Same depth: the shapes can only differ where one side has a parameter and
  // the other a literal — `/orders/:id` does receive a call to `/orders/status`
  // unless a more specific route claims it. Real match, but not a certain one.
  if (d.length === c.length) {
    return alignsAt(d, c, 0)
      ? { matched: true, confidence: 0.8, reason: 'a parameter segment matched a literal path segment' }
      : NO;
  }

  // Different depth: the only benign cause is an unconfigured mount prefix.
  // A mount prefix is always static, and dropping it must leave the *tails*
  // identical — otherwise `/orders/*` would "match" `/orders/*/items`, which is
  // a different endpoint entirely.
  const [short, long] = d.length < c.length ? [d, c] : [c, d];
  const offset = long.length - short.length;
  const prefix = long.slice(0, offset);
  if (short.length === 0 || prefix.includes('*')) return NO;
  if (short[short.length - 1] !== long[long.length - 1]) return NO;
  if (!short.some((s) => s !== '*')) return NO; // need one literal segment in common
  if (!alignsAt(short, long, offset)) return NO;
  return {
    matched: true,
    confidence: 0.6,
    reason: `path prefix differs (\`/${prefix.join('/')}\`) — set \`basePath\` in the workspace config to confirm`,
  };
}
