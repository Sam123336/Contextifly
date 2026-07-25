import { writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { computeSavings, type SavingsSummary } from '../store/usage-ledger';
import { graphDir } from '../store/graph-store';

/**
 * Render the exploration-avoided analytics as a fully self-contained styled
 * HTML dashboard (no CDN, works offline — same theme as graph.html) and save
 * it to <project>/.pixelcontextifly/savings.html.
 *
 * Every figure is badged measured or estimated — the page is honest by
 * construction, mirroring the markdown report.
 */
export function saveSavingsHtml(projectRoot: string): string | null {
  const summary = computeSavings(projectRoot);
  if (!summary) return null;
  const file = path.join(graphDir(path.resolve(projectRoot)), 'savings.html');
  writeFileSync(file, renderSavingsHtml(path.basename(path.resolve(projectRoot)), summary));
  return file;
}

export function renderSavingsHtml(project: string, s: SavingsSummary): string {
  const est = `<span class="badge est">estimated</span>`;
  const meas = `<span class="badge meas">measured</span>`;
  const spentPct = s.avoided > 0 ? Math.max(1, Math.round((s.spent / s.avoided) * 100)) : 100;

  const cards = [
    card(`~${fmt(s.filesAvoided)}`, 'files the AI did not read', est),
    card(`~${s.reduction}%`, 'exploration reduction', est),
    s.medianMs !== undefined
      ? card(`${fmt(s.medianMs)} ms`, 'median answer latency', meas)
      : card('—', 'median answer latency', '<span class="badge">no data yet</span>'),
    card(fmt(s.queries), 'architecture questions answered', meas),
  ].join('\n');

  const toolRows = s.byTool
    .map((t) => {
      const red = t.base > 0 ? `${Math.round(((t.base - t.out) / t.base) * 100)}%` : '—';
      const width = t.base > 0 ? Math.max(1, Math.round((t.out / t.base) * 100)) : 100;
      return `<tr>
        <td><code>${esc(t.tool)}</code></td>
        <td class="num">${t.calls}</td>
        <td class="num">${fmt(t.out)}</td>
        <td class="num">~${fmt(Math.round(t.base / s.tokensPerFile))}</td>
        <td class="num">~${fmt(t.base)}</td>
        <td class="num strong">${red}</td>
        <td class="barcell"><div class="minibar"><span style="width:${width}%"></span></div></td>
      </tr>`;
    })
    .join('\n');

  const shotsSection = s.shots
    ? (() => {
        const { count, image, markdown } = s.shots!;
        const saved = image - markdown;
        const pct = image > 0 ? Math.round((saved / image) * 100) : 0;
        const mdPct = image > 0 ? Math.max(1, Math.round((markdown / image) * 100)) : 100;
        return `
  <section>
    <h2>Screenshot engine <span class="sub">all projects — ${meas} by the backend</span></h2>
    <div class="compare">
      <div class="row">
        <span class="rowlabel">Raw images</span>
        <div class="bar without"><span style="width:100%"></span></div>
        <span class="rowval">${fmt(image)} tokens</span>
      </div>
      <div class="row">
        <span class="rowlabel">Markdown paid</span>
        <div class="bar with"><span style="width:${mdPct}%"></span></div>
        <span class="rowval">${fmt(markdown)} tokens</span>
      </div>
    </div>
    <p class="note">${count} screenshot(s) compressed — <strong>${fmt(saved)} tokens saved (${pct}%)</strong>, real backend measurements.</p>
  </section>`;
      })()
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Contextifly — exploration avoided</title>
<style>
  :root {
    --bg: #0d1117; --panel: #161b22; --border: #30363d;
    --text: #e6edf3; --muted: #8b949e;
    --green: #34d399; --amber: #f59e0b; --blue: #60a5fa; --red: #f87171;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: var(--bg); color: var(--text); min-height: 100vh;
    font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    padding: 28px 20px 48px;
  }
  main { max-width: 880px; margin: 0 auto; display: flex; flex-direction: column; gap: 22px; }
  header h1 { font-size: 20px; font-weight: 650; }
  header .meta { color: var(--muted); font-size: 12px; margin-top: 4px; }
  .badge {
    display: inline-block; font-size: 10px; font-weight: 600; letter-spacing: .4px;
    text-transform: uppercase; border-radius: 10px; padding: 1px 8px;
    border: 1px solid var(--border); color: var(--muted); vertical-align: middle;
  }
  .badge.meas { color: var(--green); border-color: color-mix(in srgb, var(--green) 45%, transparent); }
  .badge.est  { color: var(--amber); border-color: color-mix(in srgb, var(--amber) 45%, transparent); }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
  .card {
    background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
    padding: 16px 18px; display: flex; flex-direction: column; gap: 4px;
  }
  .card .value { font-size: 26px; font-weight: 700; letter-spacing: -.5px; }
  .card .label { color: var(--muted); font-size: 12px; }
  section {
    background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
    padding: 18px 20px;
  }
  section h2 { font-size: 14px; font-weight: 650; margin-bottom: 14px; }
  section h2 .sub { color: var(--muted); font-weight: 400; font-size: 12px; }
  .compare { display: flex; flex-direction: column; gap: 10px; }
  .row { display: grid; grid-template-columns: 130px 1fr 150px; align-items: center; gap: 12px; }
  .rowlabel { color: var(--muted); font-size: 12px; text-align: right; }
  .rowval { font-size: 12px; color: var(--text); }
  .bar { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; height: 18px; overflow: hidden; }
  .bar span { display: block; height: 100%; border-radius: 5px; }
  .bar.without span { background: color-mix(in srgb, var(--red) 55%, transparent); }
  .bar.with span { background: color-mix(in srgb, var(--green) 65%, transparent); }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .4px; font-weight: 600; }
  tr:last-child td { border-bottom: none; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.strong { color: var(--green); font-weight: 650; }
  code { background: var(--bg); border: 1px solid var(--border); border-radius: 5px; padding: 1px 6px; font-size: 12px; }
  .barcell { width: 120px; }
  .minibar { background: color-mix(in srgb, var(--amber) 30%, transparent); border-radius: 4px; height: 8px; overflow: hidden; }
  .minibar span { display: block; height: 100%; background: var(--blue); border-radius: 4px; }
  .note { color: var(--muted); font-size: 12px; margin-top: 10px; }
  footer { color: var(--muted); font-size: 12px; line-height: 1.7; }
  footer strong { color: var(--text); }
</style>
</head>
<body>
<main>
  <header>
    <h1>Exploration avoided <span class="badge est">estimated</span> <span class="badge meas">measured</span></h1>
    <div class="meta">${esc(project)} · generated ${new Date().toISOString().slice(0, 19).replace('T', ' ')} · Contextifly</div>
  </header>

  <div class="cards">
${cards}
  </div>

  <section>
    <h2>Without graph vs with graph <span class="sub">tokens per this project's ledger</span></h2>
    <div class="compare">
      <div class="row">
        <span class="rowlabel">Exploration ${est}</span>
        <div class="bar without"><span style="width:100%"></span></div>
        <span class="rowval">~${fmt(s.avoided)} tokens · ~${fmt(s.filesAvoided)} files</span>
      </div>
      <div class="row">
        <span class="rowlabel">Graph answers ${meas}</span>
        <div class="bar with"><span style="width:${spentPct}%"></span></div>
        <span class="rowval">${fmt(s.spent)} tokens · 0 files</span>
      </div>
    </div>
    <p class="note">Without the graph, this exploration repeats every conversation — the avoided work recurs.</p>
  </section>

  <section>
    <h2>Per question type</h2>
    <table>
      <thead><tr>
        <th>Tool</th><th class="num">Calls</th>
        <th class="num">Answer tokens ${meas}</th>
        <th class="num">Files avoided ${est}</th>
        <th class="num">Exploration ${est}</th>
        <th class="num">Reduction ${est}</th><th></th>
      </tr></thead>
      <tbody>
${toolRows}
      </tbody>
    </table>
  </section>
${shotsSection}
  <footer>
    <strong>Methodology.</strong> Measured: graph-answer sizes, answer latency, screenshot compression.
    Estimated: exploration avoided, derived from a per-question baseline of how many files an assistant
    typically reads without a graph × ~${s.tokensPerFile} tokens/file — not a direct measurement of an
    alternative run. The structural point stands regardless of exact numbers: discovery is compiled once
    and queried, instead of repeated every conversation.
  </footer>
</main>
</body>
</html>`;
}

function card(value: string, label: string, badge: string): string {
  return `    <div class="card"><div class="value">${value}</div><div class="label">${label} ${badge}</div></div>`;
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
