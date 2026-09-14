/**
 * case-runner.cjs
 *
 * Executes ONE experiment cell in a clean, isolated process.
 *
 * Isolation is mandatory, not stylistic: `setGlobalDispatcher()` mutates
 * process-wide state, and merely *loading* a second copy of undici registers
 * another global symbol. Running cells in one process would let them
 * contaminate each other and invalidate the matrix.
 *
 * The endpoint is a loopback HTTP server created inside this process. This
 * removes every external variable (DNS, proxy, TLS, WAN latency) and — crucially
 * — lets us count TCP connections actually opened. That count is the decisive
 * evidence for whether a failed request ever reached the transport layer.
 *
 * Result is written to a file rather than stdout, because the Electron-hosted
 * runtime does not reliably expose stdout to a parent process.
 *
 * Usage:
 *   node case-runner.cjs --out <file> --case <name> [--undici <absPathToPkg>] [--wild] [--cwd <resolveCwd>]
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const { once } = require('events');

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) a[argv[i].slice(2)] = argv[i + 1];
  }
  return a;
}

function shortErr(e) {
  if (!e) return null;
  const frames = String(e.stack || '')
    .split('\n')
    .slice(1, 7)
    .map((s) => s.trim().replace(/\s+/g, ' '))
    .filter(Boolean);
  return {
    name: e.name || null,
    code: e.code || null,
    message: String(e.message || '').slice(0, 200),
    cause: e.cause
      ? {
          name: e.cause.name || null,
          code: e.cause.code || null,
          message: String(e.cause.message || '').slice(0, 200),
        }
      : null,
    frames,
  };
}

function dispatcherSymbols() {
  try {
    return Object.getOwnPropertySymbols(globalThis)
      .map((s) => String(s))
      .filter((s) => /globalDispatcher/i.test(s));
  } catch {
    return [];
  }
}

/** Load a specific undici copy. Falls back to dynamic import for ESM-only layouts. */
async function loadUndici(absEntryOrNull, resolveCwd) {
  let resolvedPath = null;
  let mod;

  if (absEntryOrNull) {
    resolvedPath = absEntryOrNull;
    const req = createRequire(path.join(path.dirname(absEntryOrNull), 'noop.js'));
    try {
      mod = req(absEntryOrNull);
    } catch {
      mod = await import(absEntryOrNull);
    }
  } else {
    // "wild" resolution: reproduce the production escape by resolving the bare
    // specifier from the end user's home directory, exactly as the un-bundled
    // dynamic import() did.
    const base = path.join(resolveCwd || process.cwd(), 'noop.js');
    const req = createRequire(base);
    resolvedPath = req.resolve('undici');
    try {
      mod = req('undici');
    } catch {
      mod = await import(resolvedPath);
    }
  }

  let version = null;
  try {
    const pkgPath = path.join(path.dirname(resolvedPath), 'package.json');
    version = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
  } catch {
    /* version stays null */
  }

  return { mod, resolvedPath, version };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const caseName = args.case;
  const outFile = args.out;

  const rec = {
    case: caseName,
    ok: false,
    runtime: {
      exe: process.execPath,
      node: process.version,
      bundledUndici: process.versions.undici,
      platform: process.platform,
    },
    externalUndici: null,
    contract: null,
    http: null,
    error: null,
    fatal: null,
  };

  // Symbol census BEFORE loading any foreign copy.
  const symbolsBefore = dispatcherSymbols();

  let ext = null;
  if (caseName !== 'baseline') {
    try {
      ext = await loadUndici(args.undici || null, args.cwd);
      rec.externalUndici = {
        version: ext.version,
        resolvedPath: ext.resolvedPath,
      };
    } catch (e) {
      rec.fatal = 'load external undici failed: ' + (e && e.message ? e.message : String(e));
      fs.writeFileSync(outFile, JSON.stringify(rec, null, 2), 'utf8');
      return;
    }
  }

  // ---- loopback endpoint with TCP accounting ----
  let tcpOpened = 0;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  server.on('connection', () => {
    tcpOpened++;
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/probe`;

  // ---- build request options per case ----
  const opts = { method: 'GET' };
  let fetchFn = globalThis.fetch;
  let agent = null;

  try {
    if (caseName === 'per-request' || caseName === 'paired') {
      const Agent = ext.mod.Agent;
      agent = new Agent({ connections: 1, keepAliveTimeout: 1000 });
      rec.contract = {
        agentOnRequestStart: typeof agent.onRequestStart,
        agentDispatch: typeof agent.dispatch,
        agentCtor: Agent && Agent.name ? Agent.name : null,
      };
      opts.dispatcher = agent;
      if (caseName === 'paired') {
        // sender and dispatcher from the SAME copy -> contract holds
        if (typeof ext.mod.fetch !== 'function') throw new Error('external undici exposes no fetch');
        fetchFn = ext.mod.fetch;
      }
    } else if (caseName === 'set-global') {
      const Agent = ext.mod.Agent;
      agent = new Agent({ connections: 1, keepAliveTimeout: 1000 });
      rec.contract = {
        agentOnRequestStart: typeof agent.onRequestStart,
        agentDispatch: typeof agent.dispatch,
        agentCtor: Agent && Agent.name ? Agent.name : null,
      };
      if (typeof ext.mod.setGlobalDispatcher !== 'function')
        throw new Error('external undici exposes no setGlobalDispatcher');
      ext.mod.setGlobalDispatcher(agent);
    } else if (caseName === 'handler-strict') {
      // Contract-strictness probe. Call the foreign dispatch path DIRECTLY with
      // a handler that deliberately omits `onRequestStart` -- the shape a
      // bundled 6.x fetch produces. Whether this throws measures whether the
      // foreign copy treats the hook as optional or mandatory.
      const Agent = ext.mod.Agent;
      agent = new Agent({ connections: 1, keepAliveTimeout: 1000 });
      rec.contract = {
        agentOnRequestStart: typeof agent.onRequestStart,
        agentDispatch: typeof agent.dispatch,
        agentCtor: Agent && Agent.name ? Agent.name : null,
      };
      const minimalHandler = {
        onConnect() {},
        onHeaders() {
          return true;
        },
        onData() {
          return true;
        },
        onComplete() {},
        onError() {},
        onUpgrade() {},
      };
      // note: no onRequestStart -- this is the point of the probe
      try {
        agent.dispatch(
          { origin: 'http://127.0.0.1:1', path: '/strictness-probe', method: 'GET' },
          minimalHandler
        );
        rec.strictness = 'optional (accepted handler without onRequestStart)';
      } catch (e) {
        rec.strictness = 'mandatory (rejected handler without onRequestStart): ' + (e.code || e.message);
      }
      rec.http = { status: null, tcpConnectionsOpened: tcpOpened, elapsedMs: 0 };
      rec.ok = false;
      rec.note = 'contract probe only; no request issued';
      server.close();
      try {
        if (typeof agent.close === 'function') await agent.close();
      } catch {
        /* ignore */
      }
      fs.writeFileSync(outFile, JSON.stringify(rec, null, 2), 'utf8');
      return;
    } else if (caseName === 'shimmed') {
      // Causal intervention. Wrap the foreign Agent in a shim that adds the
      // hook the foreign copy demands, then use it as the per-request
      // dispatcher. If the failure is caused by the missing hook, this flips
      // FAIL -> PASS. If it still fails, the hook is not the cause.
      const Agent = ext.mod.Agent;
      agent = new Agent({ connections: 1, keepAliveTimeout: 1000 });
      rec.contract = {
        agentOnRequestStart: typeof agent.onRequestStart,
        agentDispatch: typeof agent.dispatch,
        agentCtor: Agent && Agent.name ? Agent.name : null,
      };
      const realAgent = agent;
      const shim = {
        dispatch(opts, handler) {
          if (handler && typeof handler.onRequestStart !== 'function') {
            handler.onRequestStart = function () {
              return false;
            };
          }
          if (handler && typeof handler.onResponseError !== 'function') {
            handler.onResponseError = function (err) {
              if (typeof handler.onError === 'function') handler.onError(err);
            };
          }
          return realAgent.dispatch(opts, handler);
        },
        close() {
          return realAgent.close();
        },
        destroy() {
          return realAgent.destroy();
        },
      };
      opts.dispatcher = shim;
      agent = shim;
    }
  } catch (e) {
    rec.fatal = 'setup failed: ' + (e && e.message ? e.message : String(e));
    server.close();
    fs.writeFileSync(outFile, JSON.stringify(rec, null, 2), 'utf8');
    return;
  }

  // ---- execute ----
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 6000);
  const t0 = process.hrtime.bigint();
  let status = null;

  try {
    const res = await fetchFn(url, { ...opts, signal: ac.signal });
    status = res.status;
    await res.text();
    rec.ok = true;
  } catch (e) {
    rec.error = shortErr(e);
  } finally {
    clearTimeout(timer);
  }

  const t1 = process.hrtime.bigint();
  const elapsedMs = Number(t1 - t0) / 1e6;

  rec.http = {
    status,
    tcpConnectionsOpened: tcpOpened,
    elapsedMs: Math.round(elapsedMs * 100) / 100,
  };
  rec.symbols = {
    before: symbolsBefore,
    after: dispatcherSymbols(),
  };

  server.close();
  try {
    if (agent && typeof agent.close === 'function') await agent.close();
  } catch {
    /* ignore */
  }

  fs.writeFileSync(outFile, JSON.stringify(rec, null, 2), 'utf8');
  process.exit(0);
}

main().catch((e) => {
  const args = parseArgs(process.argv.slice(2));
  try {
    fs.writeFileSync(
      args.out,
      JSON.stringify({ case: args.case, ok: false, fatal: 'unhandled: ' + (e && e.stack ? e.stack : String(e)) }, null, 2),
      'utf8'
    );
  } catch {
    /* ignore */
  }
  process.exit(1);
});
