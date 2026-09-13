/**
 * The sandbox-era entry point: an environment in, a listening shell out.
 * The capability list comes from the capabilities package's registry, so this file
 * names no capability, and `composition.ts` owns every refusal to boot.
 * Run: WEBHOOK_SECRET=… REPO_OWNER=… REPO_NAME=… pnpm --filter @hiero-hackers/automation-runtime start
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { Store } from "../../store/index.js";
import { CAPABILITIES } from "@hiero-hackers/automation-capabilities";
import { createApplier, type Applier } from "../apply/apply.js";
import { createShell } from "./shell.js";
import { CONFIG_PATH, fileConfigSource } from "../decide/config.js";
import { stubbedExternals } from "../decide/externals.js";
import { createLogger, detailOf } from "../log.js";
import { defaultDataDir } from "../paths.js";
import { createShutdown } from "../jobs/shutdown.js";
import { parseComposition } from "./composition.js";
import { liveGitHub } from "./live.js";

/** The name this process holds both kinds of claim under — a delivery's and a lease's. */
const WORKER = `shell-${randomUUID()}`;

const parsed = parseComposition(process.env);
if (!parsed.ok) {
    for (const refusal of parsed.errors) console.error(refusal);
    process.exit(1);
}
const { credentials, endpoint, paths, repository, switches, tickMs, writes } = parsed.composition;
const sweepRecord = parsed.composition.sweep;
mkdirSync(defaultDataDir(process.env), { recursive: true });

/** Everything past the refusals above says what it did, in JSON. */
const log = createLogger();
/** One clock for the whole composition — the applier's leases and the sweep's. */
const clock = (): Date => new Date();
/** The shipped declarations, as the adapter's reads want them. */
const knownCapabilities = CAPABILITIES.map(({ declaration }) => declaration);

const store = new Store(paths.storeFile);

const live =
    credentials === null
        ? null
        : liveGitHub({
              credentials,
              repository,
              writes,
              killSwitchActive: switches.killSwitch,
              clock,
              knownCapabilities,
              // The seam GitHub's own actor cannot answer: this item's landed calls (D159).

              ownWrites: (item) => store.ledger.landedOn(repository, item),
              log,
          });
const configSource = live?.configSource ?? fileConfigSource(paths.configFile);
const externals =
    live?.externals ?? (() => stubbedExternals({ killSwitchActive: switches.killSwitch }));
const writePath = live?.writePath ?? null;

/**
 * The write path, wired or absent — whether `mode: active` is honourable here.
 * With no applier the delivery lane records `modeUnsupported` before `decide()` runs.
 */
const applier: Applier | undefined =
    writePath === null
        ? undefined
        : createApplier({
              ledger: store.ledger,
              ...writePath,
              worker: WORKER,
              clock,
              log,
          });

/** The fact sweep, armed or absent — what this process does when nobody is talking. */
const sweep =
    sweepRecord === null || live === null
        ? undefined
        : { facts: live.facts, requestsMade: live.requestsMade, ...sweepRecord };

const shell = createShell({
    secret: endpoint.secret,
    store,
    capabilities: CAPABILITIES,
    configSource,
    externals,
    repository,
    worker: WORKER,
    clock,
    tickMs,
    suspended: switches.suspended,
    ...(applier === undefined ? {} : { applier }),
    ...(sweep === undefined ? {} : { sweep }),
    log,
});

// Start recovering anything a previous run left pending before listening.

void shell.drain().catch((error: unknown) => {
    log({ event: "drainFailed", phase: "startup", detail: detailOf(error) });
});
// An undefined host is the unnamed case: node reads it as no host at all.

shell.server.listen(endpoint.port, endpoint.host, () => {
    log({
        event: "startup",
        port: endpoint.port,
        host: endpoint.host ?? null,
        repository: `${repository.owner}/${repository.repo}`,
        configSource: live === null ? "local" : "live",
        // Which file, either way: the local copy, or the path on the default branch.

        configPath: live === null ? paths.configFile : CONFIG_PATH,
        storePath: paths.storeFile,
        // Which composition is running; `modeUnsupported` and "absent" are one fact.

        writes: writes === null ? "absent" : "armed",
        // The same fact for the other lane.

        sweep: sweepRecord === null ? "absent" : "armed",
        // Whether this process decides anything at all (D171).

        suspended: switches.suspended,
    });
});

/** The order that loses nothing lives in `jobs/shutdown.ts`; this is its wiring. */
const shutdown = createShutdown({
    server: shell.server,
    stopTick: shell.stopTick,
    settled: shell.settled,
    store,
    log,
    out: process.stdout,
    exit: () => process.exit(0),
});
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
