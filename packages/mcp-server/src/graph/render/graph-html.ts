import { writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { graphDir } from '../store/graph-store';
import type { ProjectGraph } from '../types';

/**
 * Render the graph as a fully self-contained interactive HTML page
 * (vanilla JS force-directed canvas — no CDN, works offline) and save it
 * to <project>/.pixelcontextifly/graph.html.
 */
export function saveGraphHtml(graph: ProjectGraph): string {
  const file = path.join(graphDir(graph.root), 'graph.html');
  writeFileSync(file, renderGraphHtml(graph));
  return file;
}

export function renderGraphHtml(graph: ProjectGraph): string {
  const payload = JSON.stringify({
    project: path.basename(graph.root),
    indexedAt: graph.indexedAt,
    commit: graph.commit ?? null,
    nodes: graph.nodes,
    edges: graph.edges,
  }).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Contextifly — code knowledge graph</title>
<style>
  :root {
    --bg: #0d1117; --panel: #161b22; --border: #30363d;
    --text: #e6edf3; --muted: #8b949e;
    --c-route: #f59e0b; --c-component: #60a5fa; --c-hook: #34d399;
    --c-context: #c084fc; --c-api: #f87171; --c-file: #6b7280;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%; overflow: hidden; }
  body {
    background: var(--bg); color: var(--text);
    font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    display: flex; flex-direction: column;
  }
  header {
    display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
    padding: 10px 16px; background: var(--panel); border-bottom: 1px solid var(--border);
  }
  header h1 { font-size: 15px; font-weight: 600; }
  header .meta { color: var(--muted); font-size: 12px; }
  #search {
    background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
    color: var(--text); padding: 5px 10px; width: 210px; outline: none;
  }
  #search:focus { border-color: var(--c-component); }
  .filters { display: flex; gap: 10px; flex-wrap: wrap; }
  .filters label {
    display: inline-flex; align-items: center; gap: 5px;
    cursor: pointer; user-select: none; font-size: 12px; color: var(--muted);
  }
  .filters .dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
  #main { flex: 1; display: flex; min-height: 0; }
  #graphwrap { flex: 1; position: relative; min-width: 0; }
  #canvas { position: absolute; inset: 0; width: 100%; height: 100%; cursor: grab; }
  #panel {
    width: 300px; background: var(--panel); border-left: 1px solid var(--border);
    padding: 14px; overflow-y: auto; display: none;
  }
  #panel.open { display: block; }
  #panel h2 { font-size: 14px; word-break: break-all; }
  #panel .type { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; }
  #panel .file { color: var(--muted); font-size: 12px; word-break: break-all; margin: 4px 0 12px; }
  #panel h3 { font-size: 11px; text-transform: uppercase; color: var(--muted); margin: 12px 0 4px; }
  #panel ul { list-style: none; }
  #panel li {
    padding: 3px 0; font-size: 12px; word-break: break-all; cursor: pointer;
  }
  #panel li:hover { color: var(--c-component); }
  #panel li .kind { color: var(--muted); font-size: 11px; }
  #hint { position: fixed; bottom: 10px; left: 16px; color: var(--muted); font-size: 11px; }
</style>
</head>
<body>
<header>
  <h1>🕸 <span id="title"></span></h1>
  <span class="meta" id="meta"></span>
  <input id="search" type="search" placeholder="Search nodes…">
  <div class="filters" id="filters"></div>
</header>
<div id="main">
  <div id="graphwrap"><canvas id="canvas"></canvas></div>
  <aside id="panel"></aside>
</div>
<div id="hint">drag background to pan · wheel to zoom · drag nodes · click a node for details</div>
<script>
'use strict';
var DATA = ${payload};

var COLORS = {
  route: '#f59e0b', component: '#60a5fa', hook: '#34d399',
  context: '#c084fc', api: '#f87171', file: '#6b7280',
  controller: '#fb923c', service: '#818cf8', module: '#a3a3a3', entity: '#facc15',
  channel: '#2dd4bf', native: '#f472b6'
};
var TYPES = ['route', 'component', 'hook', 'context', 'api',
  'controller', 'service', 'module', 'entity', 'channel', 'native', 'file'];
var enabled = { route: true, component: true, hook: true, context: true, api: true,
  controller: true, service: true, module: true, entity: true,
  channel: true, native: true, file: false };

document.getElementById('title').textContent = DATA.project;
document.getElementById('meta').textContent =
  DATA.nodes.length + ' nodes · ' + DATA.edges.length + ' edges · indexed ' +
  DATA.indexedAt.slice(0, 19).replace('T', ' ') +
  (DATA.commit ? ' @ ' + DATA.commit.slice(0, 7) : '');

// --- filters -------------------------------------------------------------
var filtersEl = document.getElementById('filters');
TYPES.forEach(function (t) {
  var count = DATA.nodes.filter(function (n) { return n.type === t; }).length;
  if (count === 0) return;
  var label = document.createElement('label');
  var cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = enabled[t];
  cb.addEventListener('change', function () { enabled[t] = cb.checked; rebuild(); });
  var dot = document.createElement('span');
  dot.className = 'dot';
  dot.style.background = COLORS[t];
  label.appendChild(cb);
  label.appendChild(dot);
  label.appendChild(document.createTextNode(t + ' (' + count + ')'));
  filtersEl.appendChild(label);
});

// --- graph state ---------------------------------------------------------
var byId = {};
DATA.nodes.forEach(function (n) { byId[n.id] = n; });
var nodes = [], links = [], nodeById = {};
var selected = null, hovered = null, query = '';

function rebuild() {
  var prev = nodeById;
  nodeById = {};
  nodes = DATA.nodes.filter(function (n) { return enabled[n.type]; }).map(function (n) {
    var old = prev[n.id];
    var node = {
      id: n.id, type: n.type, name: n.name, file: n.file || null,
      x: old ? old.x : (Math.random() - 0.5) * 800,
      y: old ? old.y : (Math.random() - 0.5) * 800,
      vx: 0, vy: 0, degree: 0
    };
    nodeById[n.id] = node;
    return node;
  });
  links = DATA.edges.filter(function (e) {
    return nodeById[e.from] && nodeById[e.to];
  }).map(function (e) {
    nodeById[e.from].degree++;
    nodeById[e.to].degree++;
    return { s: nodeById[e.from], t: nodeById[e.to], kind: e.kind };
  });
  if (selected && !nodeById[selected.id]) { selected = null; renderPanel(); }
  alpha = 1;
}

// --- physics -------------------------------------------------------------
var alpha = 1;
function tick() {
  if (alpha < 0.005) return;
  alpha *= 0.985;
  var i, j, a, b, dx, dy, d2, d, f;
  for (i = 0; i < nodes.length; i++) {
    a = nodes[i];
    for (j = i + 1; j < nodes.length; j++) {
      b = nodes[j];
      dx = a.x - b.x; dy = a.y - b.y;
      d2 = dx * dx + dy * dy;
      if (d2 < 1) d2 = 1;
      if (d2 > 90000) continue;
      f = 900 / d2 * alpha;
      d = Math.sqrt(d2);
      dx = dx / d * f; dy = dy / d * f;
      a.vx += dx; a.vy += dy; b.vx -= dx; b.vy -= dy;
    }
  }
  links.forEach(function (l) {
    dx = l.t.x - l.s.x; dy = l.t.y - l.s.y;
    d = Math.sqrt(dx * dx + dy * dy) || 1;
    f = (d - 90) * 0.02 * alpha;
    dx = dx / d * f; dy = dy / d * f;
    l.s.vx += dx; l.s.vy += dy; l.t.vx -= dx; l.t.vy -= dy;
  });
  nodes.forEach(function (n) {
    n.vx -= n.x * 0.0015 * alpha;
    n.vy -= n.y * 0.0015 * alpha;
    if (n !== dragNode) {
      n.x += n.vx; n.y += n.vy;
    }
    n.vx *= 0.85; n.vy *= 0.85;
  });
}

// --- rendering -----------------------------------------------------------
var canvas = document.getElementById('canvas');
var ctx = canvas.getContext('2d');
var view = { x: 0, y: 0, k: 1 };

function resize() {
  var r = document.getElementById('graphwrap').getBoundingClientRect();
  canvas.width = Math.max(1, r.width * devicePixelRatio);
  canvas.height = Math.max(1, r.height * devicePixelRatio);
}
window.addEventListener('resize', resize);

function radius(n) { return 5 + Math.min(9, Math.sqrt(n.degree) * 1.6); }

function neighborIds(node) {
  var ids = {};
  links.forEach(function (l) {
    if (l.s === node) ids[l.t.id] = true;
    if (l.t === node) ids[l.s.id] = true;
  });
  return ids;
}

function draw() {
  tick();
  var w = canvas.width, h = canvas.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.setTransform(view.k * devicePixelRatio, 0, 0, view.k * devicePixelRatio,
    w / 2 + view.x * devicePixelRatio, h / 2 + view.y * devicePixelRatio);

  var focus = selected || hovered;
  var neigh = focus ? neighborIds(focus) : null;

  links.forEach(function (l) {
    var lit = focus && (l.s === focus || l.t === focus);
    ctx.strokeStyle = lit ? '#e6edf3' : '#30363d';
    ctx.globalAlpha = lit ? 0.9 : 0.45;
    ctx.lineWidth = (lit ? 1.6 : 0.7) / view.k;
    ctx.beginPath();
    ctx.moveTo(l.s.x, l.s.y);
    ctx.lineTo(l.t.x, l.t.y);
    ctx.stroke();
  });
  ctx.globalAlpha = 1;

  var q = query.toLowerCase();
  nodes.forEach(function (n) {
    var r = radius(n);
    var dim = (focus && n !== focus && !neigh[n.id]) ||
      (q && n.name.toLowerCase().indexOf(q) === -1 && n.id.toLowerCase().indexOf(q) === -1);
    ctx.globalAlpha = dim ? 0.18 : 1;
    ctx.fillStyle = COLORS[n.type];
    ctx.beginPath();
    ctx.arc(n.x, n.y, r, 0, 6.2832);
    ctx.fill();
    if (n === selected) {
      ctx.strokeStyle = '#e6edf3';
      ctx.lineWidth = 2 / view.k;
      ctx.stroke();
    }
    var showLabel = !dim && (view.k > 0.7 || n.degree > 3 || n === focus || (q && !dim));
    if (showLabel) {
      ctx.fillStyle = dim ? '#4b5563' : '#e6edf3';
      ctx.font = (11 / view.k) + 'px sans-serif';
      ctx.fillText(n.name, n.x + r + 3 / view.k, n.y + 4 / view.k);
    }
  });
  ctx.globalAlpha = 1;
  requestAnimationFrame(draw);
}

// --- interaction ---------------------------------------------------------
function toWorld(e) {
  var r = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - r.left - r.width / 2 - view.x) / view.k,
    y: (e.clientY - r.top - r.height / 2 - view.y) / view.k
  };
}
function pick(e) {
  var p = toWorld(e), best = null, bestD = 1e9;
  nodes.forEach(function (n) {
    var dx = n.x - p.x, dy = n.y - p.y, d = dx * dx + dy * dy;
    var r = radius(n) + 4;
    if (d < r * r && d < bestD) { best = n; bestD = d; }
  });
  return best;
}

var dragNode = null, panning = false, last = null, moved = false;
canvas.addEventListener('mousedown', function (e) {
  moved = false;
  last = { x: e.clientX, y: e.clientY };
  dragNode = pick(e);
  if (!dragNode) panning = true;
});
window.addEventListener('mousemove', function (e) {
  if (last && (Math.abs(e.clientX - last.x) + Math.abs(e.clientY - last.y) > 3)) moved = true;
  if (dragNode) {
    var p = toWorld(e);
    dragNode.x = p.x; dragNode.y = p.y;
    alpha = Math.max(alpha, 0.3);
  } else if (panning) {
    view.x += e.clientX - last.x;
    view.y += e.clientY - last.y;
  } else {
    hovered = pick(e);
    canvas.style.cursor = hovered ? 'pointer' : 'grab';
  }
  if (last && (dragNode || panning)) last = { x: e.clientX, y: e.clientY };
});
window.addEventListener('mouseup', function (e) {
  if (!moved && last) {
    selected = pick(e);
    renderPanel();
  }
  dragNode = null; panning = false; last = null;
});
canvas.addEventListener('wheel', function (e) {
  e.preventDefault();
  var k = Math.min(4, Math.max(0.15, view.k * (e.deltaY < 0 ? 1.12 : 0.89)));
  view.k = k;
}, { passive: false });

document.getElementById('search').addEventListener('input', function (e) {
  query = e.target.value.trim();
});

// --- details panel -------------------------------------------------------
var panel = document.getElementById('panel');
function esc(s) {
  var d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
function renderPanel() {
  if (!selected) { panel.className = ''; panel.innerHTML = ''; return; }
  var n = selected;
  var html = '<span class="type" style="color:' + COLORS[n.type] + '">' + n.type + '</span>' +
    '<h2>' + esc(n.name) + '</h2>' +
    '<div class="file">' + esc(n.file || n.id) + '</div>';
  var out = [], inn = [];
  DATA.edges.forEach(function (e) {
    if (e.from === n.id && byId[e.to]) out.push(e);
    if (e.to === n.id && byId[e.from]) inn.push(e);
  });
  function section(title, list, dir) {
    if (!list.length) return '';
    var s = '<h3>' + title + ' (' + list.length + ')</h3><ul>';
    list.forEach(function (e) {
      var other = byId[dir === 'out' ? e.to : e.from];
      s += '<li data-id="' + esc(other.id) + '"><span class="kind">' + e.kind +
        (dir === 'out' ? ' → ' : ' ← ') + '</span>' + esc(other.name) + '</li>';
    });
    return s + '</ul>';
  }
  html += section('Outgoing', out, 'out') + section('Incoming', inn, 'in');
  panel.innerHTML = html;
  panel.className = 'open';
  panel.querySelectorAll('li').forEach(function (li) {
    li.addEventListener('click', function () {
      var target = nodeById[li.getAttribute('data-id')];
      if (target) {
        selected = target;
        view.x = -target.x * view.k;
        view.y = -target.y * view.k;
        renderPanel();
      }
    });
  });
}

rebuild();
resize();
draw();

// Tiny programmatic API (also handy for tests/automation).
window.PCG = {
  nodeIds: function () { return nodes.map(function (n) { return n.id; }); },
  select: function (id) {
    var n = nodeById[id];
    if (!n) return false;
    selected = n;
    view.x = -n.x * view.k;
    view.y = -n.y * view.k;
    renderPanel();
    return true;
  }
};
</script>
</body>
</html>
`;
}
