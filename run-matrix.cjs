/**
 * run-matrix.cjs
 *
 * Orchestrates the undici version-matrix experiment for the paper.
 *
 * Design rationale (this is what reviewers will probe):
 *   1. Each cell runs in a FRESH process. `setGlobalDispatcher()` mutates
 *      process-wide state and loading a second undici copy registers another
 *      global symbol, so cells would contaminate one another otherwise.
 *   2. The endpoint is loopback HTTP inside the cell process (see case-runner).
 *      No DNS, proxy, TLS or WAN involvement; TCP connections are counted,
 *      which distinguishes "rejected before transport" from "transport failed".
 *   3. Up to four runtimes are exercised, each shipping a different bundled
 *      undici. This shows the effect is not an artifact of one exact version
 *      pair. R3 is always the interpreter you run this file with; R4 is a
 *      Node.js 24 copy dropped into runtimes/; R1 and R2 are opt-in via the
 *      ELECTRON_HOST_EXE and EXTRA_NODE_EXE environment variables. Runtimes
 *      whose executable is absent are skipped, so the matrix degrades
 *      gracefully rather than silently producing empty cells.
 *   4. A "wild" cell reproduces the production escape verbatim: resolve the bare
 *      specifier from the end user's home directory.
 *
 * Usage:
 *   node run-matrix.cjs                 # prepare deps + run full matrix
 *   node run-matrix.cjs --prepare-only  # only install the versioned copies
 *   node run-matrix.cjs --skip-prepare  # reuse existing vendor copies
 *   node run-matrix.cjs --quick         # R2 only, v8 only (smoke test)
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = __dirname;
const VENDOR = path.join(ROOT, 'vendor');
const RESULTS = path.join(ROOT, 'results');
const RUNNER = path.join(ROOT, 'case-runner.cjs');

// Invoke npm through node directly rather than through npm.cmd: the latter
// requires a cmd.exe shell, which is unavailable in a sandboxed context.
// Both paths are resolved from the running interpreter so the harness is
// portable. Override with NODE_BIN / NPM_CLI if auto-detection fails for you.
const NODE_BIN = process.env.NODE_BIN || process.execPath;
const NPM_CLI =
  process.env.NPM_CLI ||
  [
    path.join(path.dirname(NODE_BIN), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(NODE_BIN), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].find((p) => fs.existsSync(p)) ||
  null;

// Home directory of the current user. The "wild" cell resolves the bare
// specifier from $HOME/node_modules, reproducing the production escape.
const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();

const VERSIONS = [6, 7, 8];

const RUNTIMES = [
  {
    // The Electron host from the incident. Its path is deliberately NOT
    // hard-coded, because it identifies a commercial product. Set
    // ELECTRON_HOST_EXE to reproduce this row; when it is unset the row is
    // skipped automatically by the availability check below.
    id: 'R1',
    label: 'Electron host (subject application)',
    exe: process.env.ELECTRON_HOST_EXE || '',
    isElectron: true,
    cwd: HOME,
  },
  {
    // Optional second interpreter carrying a different bundled undici. Set
    // EXTRA_NODE_EXE to include it; skipped when unset.
    id: 'R2',
    label: 'Additional Node.js (EXTRA_NODE_EXE)',
    exe: process.env.EXTRA_NODE_EXE || '',
    isElectron: false,
    cwd: ROOT,
  },
  {
    id: 'R3',
    label: 'Node.js (this interpreter)',
    exe: NODE_BIN,
    isElectron: false,
    cwd: ROOT,
  },
  {
    // Node.js 24 ships a bundled undici from the 7.x lineage — the only runtime on
    // this host whose built-in copy is NOT 6.x. Adding it turns the matrix from
    // "bundled 6.x x external {6,7,8}" into a two-lineage design, which removes the
    // objection that the result is an artefact of one bundled generation.
    id: 'R4',
    label: 'Node.js 24 (bundled undici 7.x)',
    exe: ROOT + '\\runtimes\\node-v24.21.0-win-x64\\node.exe',
    isElectron: false,
    cwd: ROOT,
  },
];

// baseline has no external copy; the other three are the mitigation candidates
const CASES = [
  { id: 'baseline', label: 'no dispatcher (baseline)' },
  { id: 'per-request', label: 'foreign Agent as per-request dispatcher' },
  { id: 'set-global', label: 'setGlobalDispatcher(foreign Agent)' },
  { id: 'paired', label: 'external fetch + external Agent (same copy)' },
  { id: 'shimmed', label: 'foreign Agent + handler shim (causal intervention)' },
  { id: 'handler-strict', label: 'contract-strictness probe (dispatch called directly)' },
];

function argvHas(flag) {
  return process.argv.includes(flag);
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

// ---------------------------------------------------------------- prepare

function prepare() {
  ensureDir(VENDOR);
  const prepared = {};
  for (const v of VERSIONS) {
    const dir = path.join(VENDOR, 'v' + v);
    const entry = path.join(dir, 'node_modules', 'undici', 'index.js');
    if (fs.existsSync(entry)) {
      prepared[v] = { dir, entry, skipped: true };
      console.log(`[prepare] undici@${v} present -> ${entry}`);
      continue;
    }
    ensureDir(dir);

    // A package.json MUST exist in the target directory. Without one, npm walks
    // up the tree to the nearest package.json and installs THERE — which on this
    // machine silently upgraded $HOME/node_modules/undici and rewrote the user's
    // global dependency manifest. Isolating the target is not optional.
    const manifest = path.join(dir, 'package.json');
    if (!fs.existsSync(manifest)) {
      fs.writeFileSync(
        manifest,
        JSON.stringify({ name: `undici-matrix-v${v}`, version: '1.0.0', private: true, dependencies: {} }, null, 2),
        'utf8'
      );
    }

    console.log(`[prepare] npm install undici@${v} ...`);
    const r = spawnSync(NODE_BIN, [NPM_CLI, 'install', `undici@${v}`, '--no-audit', '--no-fund', '--loglevel=error'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 240000,
    });
    if (!fs.existsSync(entry)) {
      console.error(`[prepare] FAILED for v${v}:\n${r.stdout || ''}\n${r.stderr || ''}`);
      prepared[v] = { dir, entry: null, skipped: false, failed: true };
      continue;
    }
    let version = null;
    try {
      version = JSON.parse(fs.readFileSync(path.join(dir, 'node_modules', 'undici', 'package.json'), 'utf8')).version;
    } catch {}
    console.log(`[prepare] undici@${v} -> ${version}`);
    prepared[v] = { dir, entry, version, skipped: false };
  }
  return prepared;
}

function readExternalVersion(entry) {
  try {
    return JSON.parse(fs.readFileSync(path.join(path.dirname(entry), 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- execution

// Result artifacts are meant to be published, so anything that would identify
// the machine or the commercial product under study is rewritten before it
// reaches disk. Only path-like strings are touched: outcomes, TCP counts and
// error codes are passed through unchanged, so this cannot alter a result.
// Longest / most specific paths first, otherwise the shorter prefix wins.
const REDACTIONS = [
  [process.env.ELECTRON_HOST_EXE, '<ELECTRON_HOST_EXE>'],
  [process.env.EXTRA_NODE_EXE, '<EXTRA_NODE_EXE>'],
  [ROOT, '<ROOT>'],
  [HOME, '<HOME>'],
  [NODE_BIN, '<SYSTEM_NODE_EXE>'],
  [NPM_CLI, '<NPM_CLI>'],
].filter(([plain]) => !!plain);

// Safety net: no legitimate result field contains an executable path, so any
// drive-letter path that survived the table above (for example a runtime
// discovered from PATH on a contributor's machine) is rewritten as well.
const LEFTOVER_PATH = /[A-Za-z]:\\[^\s"'<>]*\.(?:exe|node|dll|cmd|bat)/gi;

function redact(value) {
  if (typeof value === 'string') {
    let s = value;
    for (const [plain, token] of REDACTIONS) s = s.split(plain).join(token);
    return s.replace(LEFTOVER_PATH, '<REDACTED_PATH>');
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = redact(value[k]);
    return out;
  }
  return value;
}

function waitForFile(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      if (fs.existsSync(file)) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(tick, 250);
    };
    tick();
  });
}

async function runCell(runtime, args, outFile) {
  if (fs.existsSync(outFile)) {
    try {
      fs.unlinkSync(outFile);
    } catch {}
  }

  const env = { ...process.env };
  if (runtime.isElectron) {
    env.ELECTRON_RUN_AS_NODE = '1';
    env.ELECTRON_NO_ATTACH_CONSOLE = '1';
  }

  let child;
  try {
    child = spawn(runtime.exe, [RUNNER, ...args], {
      cwd: runtime.cwd,
      env,
      windowsHide: true,
      stdio: 'ignore',
    });
  } catch (e) {
    return { ok: false, fatal: 'spawn failed: ' + e.message };
  }

  const appeared = await waitForFile(outFile, runtime.isElectron ? 30000 : 20000);

  // Electron-hosted runs do not always exit on their own; reap the process.
  // Avoid shelling out to taskkill (unavailable in a sandboxed context).
  try {
    if (child.exitCode === null && child.signalCode === null && child.pid) child.kill();
  } catch {
    /* ignore */
  }

  if (!appeared) {
    return { ok: false, fatal: 'no result file within timeout' };
  }
  try {
    const cell = redact(JSON.parse(fs.readFileSync(outFile, 'utf8')));
    // Write the scrubbed form back, so the artifact on disk is safe to publish
    // even if the caller archives results/ without a further cleaning pass.
    try {
      fs.writeFileSync(outFile, JSON.stringify(cell, null, 2), 'utf8');
    } catch {
      /* non-fatal: the in-memory value is already scrubbed */
    }
    return cell;
  } catch (e) {
    return { ok: false, fatal: 'unreadable result: ' + e.message };
  }
}

// ---------------------------------------------------------------- reporting

function cellVerdict(rec) {
  if (!rec) return 'ERR';
  if (rec.fatal) return 'ERR';
  if (rec.case === 'handler-strict') return rec.strictness ? 'PROBE' : 'ERR';
  return rec.ok ? 'PASS' : 'FAIL';
}

function cellError(rec) {
  if (!rec || !rec.error) return rec && rec.fatal ? 'setup error' : '-';
  const c = rec.error.cause;
  if (c && c.code) return c.code;
  if (rec.error.code) return rec.error.code;
  return rec.error.name || 'error';
}

/** Which side threw? Determined from stack frames, not from the message. */
function errorOrigin(rec) {
  const f = rec && rec.error && rec.error.frames ? rec.error.frames.join(' | ') : '';
  if (/node:internal/.test(f)) return 'host (bundled copy)';
  if (/vendor|node_modules/.test(f)) return 'external copy';
  return 'unknown';
}

function pick(arr, pred) {
  return arr.find(pred);
}

function buildReports(cells) {
  ensureDir(RESULTS);

  fs.writeFileSync(path.join(RESULTS, 'results.json'), JSON.stringify(cells, null, 2), 'utf8');

  // ---- CSV ----
  const csv = [
    ['runtime', 'runtime_label', 'bundled_undici', 'node', 'external_undici', 'resolution', 'case', 'outcome', 'error', 'tcp_opened', 'elapsed_ms', 'onRequestStart'].join(','),
  ];
  for (const c of cells) {
    csv.push(
      [
        c.runtimeId,
        `"${c.runtimeLabel}"`,
        c.bundledUndici,
        c.node,
        c.externalVersion || 'none',
        c.resolution || '-',
        c.caseId,
        cellVerdict(c.rec),
        cellError(c.rec),
        c.rec && c.rec.http ? c.rec.http.tcpConnectionsOpened : '',
        c.rec && c.rec.http ? c.rec.http.elapsedMs : '',
        c.rec && c.rec.contract ? c.rec.contract.agentOnRequestStart : '',
      ].join(',')
    );
  }
  fs.writeFileSync(path.join(RESULTS, 'results.csv'), csv.join('\n'), 'utf8');

  // ---- condensed table (main text) ----
  // Only PINNED copies form the version axis; the wild cell is a separate
  // reproduction of the production escape and must not become a column.
  const versionsPresent = [
    ...new Set(cells.filter((c) => c.resolution === 'pinned').map((c) => c.externalVersion).filter((v) => v && v !== 'none')),
  ];
  const wildCells = cells.filter((c) => c.resolution === 'wild');

  let md = '# Table 3 (condensed) — per-request foreign dispatcher across runtimes and external versions\n\n';
  md += 'Cell value: outcome for `fetch(url, { dispatcher: new ExternalAgent() })` against a loopback endpoint.\n\n';
  md += '| Runtime | Bundled undici | Baseline (no dispatcher) | ' + versionsPresent.map((v) => 'ext. ' + v).join(' | ') + ' |\n';
  md += '|---|---|---|' + versionsPresent.map(() => '---').join('|') + '|\n';

  for (const rt of RUNTIMES) {
    const rtCells = cells.filter((c) => c.runtimeId === rt.id);
    if (!rtCells.length) continue;
    const base = pick(rtCells, (c) => c.caseId === 'baseline');
    const bundled = base && base.bundledUndici ? base.bundledUndici : '-';
    const baseV = base ? `${cellVerdict(base.rec)} (${base.rec.http ? base.rec.http.tcpConnectionsOpened : '?'} conn)` : '-';
    const row = versionsPresent.map((v) => {
      const c = pick(rtCells, (x) => x.caseId === 'per-request' && x.externalVersion === v);
      if (!c) return 'n/a';
      const conn = c.rec && c.rec.http ? c.rec.http.tcpConnectionsOpened : '?';
      const err = cellError(c.rec);
      return cellVerdict(c.rec) === 'PASS' ? `PASS (${conn} conn)` : `FAIL (${conn} conn, ${err})`;
    });
    md += `| ${rt.label} | ${bundled} | ${baseV} | ` + row.join(' | ') + ' |\n';
  }
  if (wildCells.length) {
    md += '\n### Production-escape reproduction (wild resolution from `$HOME/node_modules`)\n\n';
    md += '| Runtime | Resolved path | ext. version | `onRequestStart` | Outcome | TCP conn. opened |\n|---|---|---|---|---|---|\n';
    for (const c of wildCells) {
      const p = c.rec && c.rec.externalUndici ? c.rec.externalUndici.resolvedPath : '-';
      const t = c.rec && c.rec.contract ? c.rec.contract.agentOnRequestStart : '-';
      const conn = c.rec && c.rec.http ? c.rec.http.tcpConnectionsOpened : '?';
      md += `| ${c.runtimeLabel} | \`${p}\` | ${c.externalVersion || '?'} | ${t} | ${cellVerdict(c.rec)} | ${conn} |\n`;
    }
  }

  // ---- contract strictness: is the hook optional or mandatory? ----
  md += '\n## Contract strictness — how each external copy treats a handler lacking `onRequestStart`\n\n';
  md += 'Measured by invoking `Agent.dispatch(opts, handler)` directly with a minimal handler that omits the hook.\n\n';
  md += '| External undici | Accepts handler without `onRequestStart`? | Observed behaviour |\n|---|---|---|\n';
  const strictSeen = new Map();
  for (const c of cells) {
    if (c.caseId !== 'handler-strict' || !c.rec || !c.rec.strictness) continue;
    if (strictSeen.has(c.externalVersion)) continue;
    strictSeen.set(c.externalVersion, c.rec.strictness);
  }
  for (const [v, s] of strictSeen) {
    const mandatory = /mandatory/.test(s);
    md += `| ${v} | ${mandatory ? '**no — mandatory**' : 'yes — optional'} | ${s} |\n`;
  }

  // ---- causal intervention ----
  const shimCells = cells.filter((c) => c.caseId === 'shimmed');
  if (shimCells.length) {
    md += '\n## Causal intervention — restoring the hook on the handler\n\n';
    md += 'The same foreign Agent, wrapped so the missing hook is attached before dispatch.\n\n';
    md += '| Runtime | Ext. undici | per-request (as-is) | with handler shim | Outcome of the intervention | Where it fails |\n|---|---|---|---|---|---|\n';
    for (const c of shimCells) {
      const raw = pick(cells, (x) => x.runtimeId === c.runtimeId && x.caseId === 'per-request' && x.externalVersion === c.externalVersion);
      const rawTxt = raw ? `${cellVerdict(raw.rec)} (${raw.rec.http ? raw.rec.http.tcpConnectionsOpened : '?'} conn)` : 'n/a';
      const cause = c.rec.error ? `${cellError(c.rec)}: ${c.rec.error.cause ? c.rec.error.cause.message : c.rec.error.message}` : '-';

      // Classify: did the shim help, do nothing, or make things worse?
      let verdictTxt;
      if (raw && cellVerdict(raw.rec) === 'PASS' && cellVerdict(c.rec) === 'PASS') {
        verdictTxt = 'no effect (was already passing)';
      } else if (raw && cellVerdict(raw.rec) === 'PASS' && cellVerdict(c.rec) === 'FAIL') {
        verdictTxt = '**regression introduced by the shim**';
      } else if (raw && cellVerdict(raw.rec) === 'FAIL' && cellVerdict(c.rec) === 'FAIL') {
        verdictTxt = 'no repair — different failure, still no request on the wire';
      } else {
        verdictTxt = 'inconclusive';
      }

      md += `| ${c.runtimeLabel} | ${c.externalVersion} | ${rawTxt} | ${cellVerdict(c.rec)} (${c.rec.http ? c.rec.http.tcpConnectionsOpened : '?'} conn) | ${verdictTxt} | ${errorOrigin(c.rec)} — ${cause} |\n`;
    }
    md +=
      '\nInterpretation, per version lineage — the three outcomes must not be read as one result:\n\n' +
      '- **6.x:** the shim is inert (no assertion to satisfy); the cell passes either way.\n' +
      '- **7.x:** the copy treats the hook as *optional but authoritative* — if present, control is delegated to it. ' +
      'Injecting a no-op therefore **breaks a configuration that was previously working** (request is dispatched, ' +
      'then stalls until the timeout aborts it). This is a shim-induced regression, not a compatibility defect, ' +
      'and it shows that "add the missing method" is actively unsafe where the hook carries behaviour rather than ' +
      'merely being checked for existence.\n' +
      '- **8.x:** attaching the hook clears the *first* assertion — the error changes from `UND_ERR_INVALID_ARG` to a ' +
      '`TypeError` — which confirms the missing hook as the trigger. But the request still fails and the subsequent ' +
      'error is raised on the **host** side, with no connection ever opened.\n\n' +
      'Taken together: the incompatibility is structural, not a single missing member. A host-era handler and a ' +
      'foreign-era dispatcher cannot be made to interoperate by patching one method, and on the 7.x lineage such a ' +
      'patch introduces a new failure. This is why the deployed mitigation removes the cross-boundary hand-off ' +
      'instead of adapting it.\n';
  }

  md += '\n## Contract probe — presence of the hook on the foreign `Agent` itself\n\n';
  md += '| External undici | `Agent.onRequestStart` | `Agent.dispatch` |\n|---|---|---|\n';
  const seen = new Map();
  for (const c of cells) {
    if (!c.rec || !c.rec.contract || !c.externalVersion) continue;
    if (seen.has(c.externalVersion)) continue;
    const ct = c.rec.contract;
    seen.set(c.externalVersion, ct);
  }
  for (const [v, ct] of seen) {
    md += `| ${v} | ${ct.agentOnRequestStart} | ${ct.agentDispatch} |\n`;
  }
  md +=
    '\nNote: the hook is absent from the *Agent* in every version tested, so Agent shape is **not** the discriminator. ' +
    'The discriminator is how strictly the foreign copy validates the *handler* it is handed (table above).\n';

  fs.writeFileSync(path.join(RESULTS, 'table3-condensed.md'), md, 'utf8');

  // ---- full table (appendix) ----
  let full = '# Table A — full cell results\n\n';
  full += '| Runtime | Node | Bundled undici | Ext. undici | Case | Outcome | Error | TCP opened | Latency (ms) | `onRequestStart` |\n|---|---|---|---|---|---|---|---|---|---|\n';
  for (const c of cells) {
    const conn = c.rec && c.rec.http ? c.rec.http.tcpConnectionsOpened : '?';
    const ms = c.rec && c.rec.http ? c.rec.http.elapsedMs : '?';
    const t = c.rec && c.rec.contract ? c.rec.contract.agentOnRequestStart : '-';
    full += `| ${c.runtimeLabel} | ${c.node} | ${c.bundledUndici} | ${c.externalVersion || '—'} | ${c.caseLabel}${c.resolution === 'wild' ? ' (wild)' : ''} | ${cellVerdict(c.rec)} | ${cellError(c.rec)} | ${conn} | ${ms} | ${t} |\n`;
  }
  fs.writeFileSync(path.join(RESULTS, 'table-full.md'), full, 'utf8');

  console.log('\n[report] written to ' + RESULTS);
}

// ---------------------------------------------------------------- main

async function main() {
  const quick = argvHas('--quick');
  ensureDir(RESULTS);

  let prepared = {};
  if (!argvHas('--skip-prepare')) {
    if (!NPM_CLI) {
      console.error(
        '[fatal] could not locate npm-cli.js next to ' + NODE_BIN + '\n' +
        '        Set NPM_CLI to its full path, or run with --skip-prepare if the\n' +
        '        vendor copies in vendor/v{6,7,8} are already installed.'
      );
      process.exit(1);
    }
    prepared = prepare();
    if (argvHas('--prepare-only')) {
      console.log('[prepare-only] done.');
      return;
    }
  } else {
    for (const v of VERSIONS) {
      const dir = path.join(VENDOR, 'v' + v);
      const entry = path.join(dir, 'node_modules', 'undici', 'index.js');
      if (fs.existsSync(entry)) prepared[v] = { dir, entry };
    }
  }

  // Skip any runtime whose executable is absent (e.g. R4 if the Node 24 copy was
  // never downloaded into runtimes/). Silently running it would produce 16 cells
  // of launch errors; silently dropping it would let the two-lineage claim in the
  // manuscript go unsupported without anyone noticing. So: drop it, and say so.
  const missing = RUNTIMES.filter((r) => !fs.existsSync(r.exe));
  if (missing.length) {
    console.log(
      '[warn] runtime executable(s) not found, cells skipped: ' +
        missing.map((r) => `${r.id} (${r.exe})`).join('; ')
    );
    console.log(
      '[warn] if R4 is missing the matrix degrades to a single bundled lineage — revise §6.6 and §8 accordingly.'
    );
  }
  const available = RUNTIMES.filter((r) => fs.existsSync(r.exe));
  const runtimes = quick ? available.filter((r) => r.id === 'R3') : available;
  const versions = quick ? [8] : VERSIONS;

  const cells = [];
  let n = 0;

  for (const rt of runtimes) {
    if (!fs.existsSync(rt.exe)) {
      console.warn(`[skip] runtime ${rt.id} not found: ${rt.exe}`);
      continue;
    }
    console.log(`\n=== ${rt.id} ${rt.label} ===`);

    // baseline once per runtime
    n++;
    const outB = path.join(RESULTS, `_cell_${rt.id}_baseline.json`);
    const recB = await runCell(rt, ['--out', outB, '--case', 'baseline'], outB);
    cells.push({
      runtimeId: rt.id,
      runtimeLabel: rt.label,
      node: recB.runtime ? recB.runtime.node : '?',
      bundledUndici: recB.runtime ? recB.runtime.bundledUndici : '?',
      externalVersion: 'none',
      resolution: '-',
      caseId: 'baseline',
      caseLabel: 'no dispatcher (baseline)',
      rec: recB,
    });
    console.log(`  baseline -> ${cellVerdict(recB)} tcp=${recB.http ? recB.http.tcpConnectionsOpened : '?'}`);

    for (const v of versions) {
      const prep = prepared[v];
      if (!prep || !prep.entry) {
        console.warn(`  [skip] v${v} unavailable`);
        continue;
      }
      const extVer = readExternalVersion(prep.entry) || String(v);
      for (const c of CASES.filter((x) => x.id !== 'baseline')) {
        n++;
        const out = path.join(RESULTS, `_cell_${rt.id}_v${v}_${c.id}.json`);
        const rec = await runCell(rt, ['--out', out, '--case', c.id, '--undici', prep.entry], out);
        cells.push({
          runtimeId: rt.id,
          runtimeLabel: rt.label,
          node: rec.runtime ? rec.runtime.node : '?',
          bundledUndici: rec.runtime ? rec.runtime.bundledUndici : '?',
          externalVersion: extVer,
          resolution: 'pinned',
          caseId: c.id,
          caseLabel: c.label,
          rec,
        });
        console.log(
          `  v${extVer} ${c.id} -> ${cellVerdict(rec)} tcp=${rec.http ? rec.http.tcpConnectionsOpened : '?'} err=${cellError(rec)}`
        );
      }
    }

    // wild cell: only meaningful where the production escape occurred
    if (!quick && rt.id === 'R1') {
      n++;
      const out = path.join(RESULTS, `_cell_${rt.id}_wild_per-request.json`);
      const rec = await runCell(
        rt,
        ['--out', out, '--case', 'per-request', '--wild', '--cwd', HOME],
        out
      );
      cells.push({
        runtimeId: rt.id,
        runtimeLabel: rt.label,
        node: rec.runtime ? rec.runtime.node : '?',
        bundledUndici: rec.runtime ? rec.runtime.bundledUndici : '?',
        externalVersion: rec.externalUndici ? rec.externalUndici.version : '?',
        resolution: 'wild',
        caseId: 'per-request',
        caseLabel: 'foreign Agent as per-request dispatcher',
        rec,
      });
      console.log(`  WILD -> ${cellVerdict(rec)} tcp=${rec.http ? rec.http.tcpConnectionsOpened : '?'}`);
    }
  }

  console.log(`\n[done] ${n} cells executed`);
  buildReports(cells);

  const pass = cells.filter((c) => cellVerdict(c.rec) === 'PASS').length;
  const fail = cells.filter((c) => cellVerdict(c.rec) === 'FAIL').length;
  const err = cells.filter((c) => cellVerdict(c.rec) === 'ERR').length;
  console.log(`[summary] PASS=${pass} FAIL=${fail} ERR=${err}`);
}

main().catch((e) => {
  console.error('[fatal]', e);
  process.exit(1);
});
