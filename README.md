# Reproduction Package — undici Version-Matrix Experiment

Artifact accompanying the manuscript *"Silent Network Failures in Hybrid Runtimes:
Diagnosing Dependency Resolution Escape via In-Runtime Differential Probing"*.

This package produces **Tables 3 to 6** of the manuscript from a single command:
the version matrix (Table 3), the complete 65-cell accounting (Table 4), the
contract-strictness probe (Table 5) and the intervention outcome (Table 6).
The underlying per-cell records in `results/` are the raw data behind all four.

---

## 1. What the experiment tests

**Hypothesis.** When a runtime bundles one copy of `undici` (backing the global
`fetch`) and an application loads a *different* copy from outside its packaging
boundary, passing an object from the foreign copy across the contract boundary
of the bundled copy causes request rejection **before any network operation is
attempted**.

**Independent variables.**

| Variable | Levels |
|---|---|
| Runtime (bundled undici) | Electron host 6.22.0 · Node 22.22.2 / 6.24.1 · Node 22.22.0 / 6.23.0 · **Node 24.21.0 / 7.29.1** — see §3 for how each is enabled |
| External undici version | 6.x · 7.x · 8.x (pinned, isolated) + `8.1.0` (wild-resolved from `$HOME`) |
| Dispatcher strategy | none (baseline) · per-request · `setGlobalDispatcher` · paired same-copy `fetch` · shimmed (intervention) · contract-strictness probe |

**Dependent variables.** outcome, error code, **TCP connections actually opened**,
latency, and presence of the contract hook `Agent.onRequestStart`.

---

## 2. Why the design is shaped this way

Three decisions carry the validity of the result; each answers a specific
objection a reviewer will raise.

**(a) One process per cell.** `setGlobalDispatcher()` mutates process-wide
state, and *merely loading* a second copy of undici registers an additional
global symbol (`Symbol(undici.globalDispatcher.N)`). Pooling cells into one
process would let them contaminate each other, and a reviewer could reasonably
dismiss every result. Cells are therefore fully isolated.

**(b) Loopback endpoint with TCP accounting.** The endpoint is an HTTP server
created inside the cell process. This removes DNS, proxy, TLS and WAN latency
from the measurement. More importantly, the server counts incoming TCP
connections, which yields the study's decisive observation:

> In every failing cell, `tcpConnectionsOpened = 0`.

This is *direct* evidence that the request was rejected during argument
validation and never reached the transport layer — as opposed to the
weaker, indirect evidence available in production logs (`elapsedMs = 0`),
which a reviewer could attribute to clock granularity or buffering.

**(c) Four runtimes spanning two bundled lineages.** A single version pair would
support the objection that the result is an artifact of one unlucky
combination. Three runtimes already on the study machine ship bundled
6.22.0, 6.23.0 and 6.24.1 — all from the 6.x lineage, which by itself leaves
the "one generation only" objection open. A fourth runtime, **Node.js 24,
bundling undici 7.x**, was therefore added to make the bundled side a
two-lineage factor.

Its inclusion produces the most informative cell in the whole matrix: bundled
7.29.1 paired with external 7.29.1 is *the same release* on both sides of the
boundary and passes, while the same runtime handed external 8.10.2 fails
exactly like every 6.x host. Version distance is therefore not the discriminator,
and upgrading the host runtime does not avoid the defect.

---

## 3. What the experiment actually found (read this before citing)

The intuitive generalization — "two copies at different versions break" — is
**false**, and the matrix is what disproves it.

| External copy | Result vs. a bundled 6.x `fetch` |
|---|---|
| 6.28.1 | PASS |
| 7.29.1 | **PASS** (different major version, still fine) |
| 8.10.2 | **FAIL** (`UND_ERR_INVALID_ARG`, 0 connections) |
| 8.1.0 (wild, as in production) | **FAIL** (0 connections) |

The discriminator is not version distance but a **contract tightening in
undici 8**:

```js
// 7.29.1  util.js:543 — optional: if present, delegate to it
if (typeof handler.onRequestStart === 'function') { return }

// 8.10.2  util.js:572 — mandatory: absence is an error
if (typeof handler.onRequestStart !== 'function') {
  throw new InvalidArgumentError('invalid onRequestStart method')
}
```

Note the direction: the **foreign copy validates the handler the bundled fetch
hands to it** — not the bundled copy inspecting the foreign Agent. A 6.x-era
handler has no `onRequestStart`, so an 8.x dispatcher rejects it.

Also note: `onRequestStart` is absent from the foreign **`Agent`** in every
version tested (6/7/8 alike). Agent shape is *not* the discriminator; only the
handler assertion is. Inspecting the Agent in isolation — our first instinct —
is inconclusive.

The intervention cell (attach the missing hook, then dispatch) yields three
different outcomes that must not be conflated: no effect on 6.x, a **regression**
on 7.x (the hook is "optional but authoritative", so a no-op truncates control
flow), and no repair on 8.x (first assertion clears, then the host side throws).
Adaptation is therefore refuted as a remedy.

---

## 3. Running it

```bat
run-matrix.bat
```

or explicitly:

```bat
node run-matrix.cjs
```

Options:

| Flag | Effect |
|---|---|
| `--prepare-only` | install the pinned undici copies, then stop |
| `--skip-prepare` | reuse existing `vendor/` copies (offline reruns) |
| `--quick` | R3 × v8 only — smoke test, ~10 s |

Runtime: roughly 1 minute for the full 65-cell matrix; the Electron-hosted cells
dominate because each spawns a full Electron process in `ELECTRON_RUN_AS_NODE`
mode.

### Which runtimes run, and how to enable more

Executable paths are resolved at run time rather than hard-coded, so the package
is portable and discloses nothing about the machine it was developed on.

| Id | Runtime | How to enable |
|---|---|---|
| R3 | the interpreter you invoke `run-matrix.cjs` with | always on |
| R4 | Node.js 24, bundled undici 7.29.1 | unpack into `runtimes/` (see below) |
| R2 | any extra Node.js with a different bundled undici | set `EXTRA_NODE_EXE` |
| R1 | the Electron host from the incident | set `ELECTRON_HOST_EXE` |

R1 and R2 are opt-in. Their executables cannot be shipped, and R1's path would
identify a commercial product that the manuscript deliberately anonymises. When a
runtime's executable is absent its cells are **skipped, not failed**, so the
matrix degrades cleanly instead of producing empty rows.

```bat
set ELECTRON_HOST_EXE=C:\path\to\Electron\App.exe
set EXTRA_NODE_EXE=C:\path\to\other\node.exe
node run-matrix.cjs
```

Two cautions. R4 is the only bundled-7.x runtime: without it the experiment
collapses to a single bundled lineage, and the two-lineage claim in §6.6 and §8
no longer holds. R1 is the only row that reproduces the production configuration
verbatim; the others are the controlled comparison. Neither is required to
observe the core result, namely that only the external 8.x copy fails.

### Runtime R4 (Node.js 24) is not installed system-wide

R4 is the only runtime whose bundled undici comes from the 7.x lineage, and it
is what lifts the bundled side out of a single generation. It is deliberately
installed **inside this artifact** rather than into the host:

```text
undici-matrix/runtimes/node-v24.21.0-win-x64/node.exe      # bundled undici 7.29.1
```

To obtain it on a fresh machine (no changes to any global Node install):

```bat
mkdir runtimes
curl -L -o runtimes\node.zip https://nodejs.org/dist/latest-v24.x/node-v24.21.0-win-x64.zip
tar -xf runtimes\node.zip -C runtimes
```

`run-matrix.cjs` resolves R4 relative to `ROOT`, so the matrix runs unchanged
once the directory is in place. If it is missing, R4's cells are skipped and
the remaining three runtimes still execute — the experiment degrades to the
single-lineage design, and the manuscript's claim about two lineages no longer
holds, so **do not drop R4 without also revising §6.6 and §8.**

---

## 4. Outputs

Written to `results/`:

| File | Purpose |
|---|---|
| `results.json` | raw per-cell records, machine-readable |
| `results.csv` | flat table for statistical tooling |
| `table3-condensed.md` | **Tables 3, 5, 6** — paste into §6.6–6.7 |
| `table-full.md` | full cell results; the basis for **Table 4** (65-cell accounting) |
| `_cell_*.json` | individual cell records, kept for audit |

`table3-condensed.md` emits everything needed for §6.6–6.7 of the manuscript:

- **Table 3** — the version matrix (runtime × external version, per-request case)
- **Table 3** — contract strictness, measured behaviourally
- **Table 4** — causal intervention outcome
- wild-resolution reproduction of the production escape
- Agent-shape probe, with the note that Agent shape is *not* the discriminator

---

## 5. Threats to validity, and what this package does about them

| Threat | Mitigation in this design |
|---|---|
| Cross-cell contamination via global state | one process per cell |
| Network confounding | loopback endpoint; no external I/O |
| Single-version artifact | four runtimes, two bundled lineages (6.x ×3, 7.x ×1) |
| Weak evidence for "never sent" | TCP connection counter, not elapsed time |
| Environment specificity | `wild` cell reproduces the exact production resolution path |
| Installation drift | pinned `vendor/vN` copies; versions read back from `package.json` and recorded |
| **Setup damaging the artifact under study** | isolated `package.json` written into every vendor dir (see §7) |

**Still not addressed.** All four runtimes are Windows/x64, so cross-platform
confirmation (macOS/Linux) remains open. Note that home-directory lookup differs
across platforms, which affects where a wild resolution lands — i.e. the
*activation* of the escape — though not the contract mechanism itself.

A runtime bundling undici **8.x or later** is also unrepresented. Such a host
would satisfy the 8.x assertion and might therefore be immune, which would make
the defect self-healing on sufficiently new runtimes — a hypothesis worth
testing, not a claim.

---

## 7. Hazard: this setup can damage the artifact it studies

Recorded because it happened, and because it is a realistic hazard of exactly
this kind of environment-dependent investigation.

An early version ran `npm install undici@N` in a vendor directory that had no
`package.json`. npm walks **up** the directory tree to the nearest manifest and
installs *there*. On this machine that silently:

- upgraded `$HOME/node_modules/undici` from **8.1.0 → 8.10.2** — the very copy
  the study is about — and
- rewrote `$HOME/package.json` (`"undici": "^8.1.0"` → `"^8.10.2"`).

The damage was detected and reversed (`npm install undici@8.1.0` in `$HOME`),
and the harness now writes an isolated manifest into each `vendor/vN` directory
before installing. **If you adapt this harness, keep that guard.**

---

## 6. Files

```
undici-matrix/
├── run-matrix.cjs     # orchestrator: prepares deps, runs cells, builds tables
├── case-runner.cjs    # executes one cell in an isolated process
├── run-matrix.bat     # one-click launcher
├── vendor/v{6,7,8}/   # pinned undici copies (created on first run)
└── results/           # generated
```
