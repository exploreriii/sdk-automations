/**
 * The sandbox-era entry point: environment in, listening shell out.
 *
 * The probes are wired as the capabilities because they are the
 * capabilities that exist; production capabilities replace this ONE
 * import, not the shell. Everything else is env-driven, with the user's
 * state home (`paths.ts`) as the default home for the store and the config
 * copy.
 *
 * The refusals below are the one thing here that is NOT structured: a
 * misconfigured boot has no delivery to correlate, no process to correlate
 * it with, and one reader — the person who just typed the variable wrong.
 * A JSON object about their typo would be a worse answer to it, so the
 * fail-closed writes stay human sentences and every line after the process
 * is alive goes through the log.
 *
 * Run:
 *   WEBHOOK_SECRET=… REPO_OWNER=… REPO_NAME=… pnpm --filter @hiero-hackers/automation-shell start
 */

import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { toEngine } from "@hiero-hackers/automation-core";
import { Store } from "@hiero-hackers/automation-store";
import { inactivity, intake, prQuality } from "@hiero-hackers/automation-probes";
import {
    createGitHubHttpClient,
    createTokenSource,
    githubConfigSource,
    githubMintInstallationToken,
    liveExternalsForDelivery,
} from "@hiero-hackers/automation-adapter";
import { createShell, DEFAULT_SWEEP_INTERVAL_MS } from "./shell.js";
import { CONFIG_PATH, fileConfigSource, type ConfigSource } from "./config.js";
import { stubbedExternals, type ExternalsForDelivery } from "./externals.js";
import { createLogger, detailOf } from "./log.js";
import { defaultDataDir, strandedStore } from "./paths.js";

/** The port this endpoint takes when PORT says nothing. */
const DEFAULT_PORT = 8790;

const env = process.env;
const secret = env["WEBHOOK_SECRET"];
const owner = env["REPO_OWNER"];
const repo = env["REPO_NAME"];
if (!secret || !owner || !repo) {
    console.error(
        "WEBHOOK_SECRET, REPO_OWNER and REPO_NAME are required (the sandbox App's secret and the repository this endpoint serves).",
    );
    process.exit(1);
}

// D93: no credentials selects CI stubs; partial credentials are an error.
const appId = env["APP_ID"];
const installationId = env["INSTALLATION_ID"];
const privateKeyPath = env["PRIVATE_KEY_PATH"];
const credentialCount = [appId, privateKeyPath, installationId].filter(Boolean).length;
if (credentialCount !== 0 && credentialCount !== 3) {
    console.error(
        "APP_ID, PRIVATE_KEY_PATH and INSTALLATION_ID must be provided together to use live GitHub access.",
    );
    process.exit(1);
}

const dataDir = defaultDataDir(env);
mkdirSync(dataDir, { recursive: true });
const configFile = env["CONFIG_FILE"] ?? join(dataDir, "automations.yml");
const storeFile = env["STORE_PATH"] ?? join(dataDir, "shell.sqlite");

const stranded = strandedStore({
    storePath: storeFile,
    overridden: env["STORE_PATH"] !== undefined,
});
// Validated rather than coerced, like the interval below: `Number("nope")`
// is NaN, which node reads as "any free port" — so a typo would bind a
// port nobody can find and announce it as `:NaN`.
const port = env["PORT"] === undefined ? DEFAULT_PORT : Number(env["PORT"]);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error("PORT must be a whole number between 1 and 65535.");
    process.exit(1);
}

// Unnamed by default, which is what binds the unspecified address —
// dual-stack on an IPv6-capable host, where "0.0.0.0" would be IPv4 only.
// A test or a sandbox names the loopback. An EMPTY name is the one value
// that means neither: it is a typo for absent, and node answers it by
// resolving the empty host rather than by refusing.
const host = env["HOST"];
if (host !== undefined && host.trim() === "") {
    console.error("HOST must be a host name or address, or unset to bind every interface.");
    process.exit(1);
}

// How often stale claims are requeued and the queue re-drained. Validated
// rather than coerced: a mistyped interval that silently became a 0ms tick
// or a NaN one would take out the recovery this exists to provide.
const sweepSeconds =
    env["SWEEP_INTERVAL_SECONDS"] === undefined
        ? DEFAULT_SWEEP_INTERVAL_MS / 1000
        : Number(env["SWEEP_INTERVAL_SECONDS"]);
if (!Number.isInteger(sweepSeconds) || sweepSeconds < 1) {
    console.error("SWEEP_INTERVAL_SECONDS must be a whole number of seconds, 1 or more.");
    process.exit(1);
}

const killSwitchActive = env["KILL_SWITCH"] === "1";
const repository = { owner, repo };
/** Everything past the last refusal above says what it did, in JSON. */
const log = createLogger();

interface LiveGitHub {
    readonly configSource: ConfigSource;
    readonly externals: ExternalsForDelivery;
}

function liveGitHub({
    appId,
    installationId,
    privateKeyPath,
}: {
    appId: string;
    installationId: string;
    privateKeyPath: string;
}): LiveGitHub {
    let privateKeyPem: string;
    try {
        privateKeyPem = readFileSync(privateKeyPath, "utf8");
    } catch {
        console.error(`PRIVATE_KEY_PATH could not be read: ${privateKeyPath}`);
        process.exit(1);
    }
    const tokenSource = createTokenSource({
        credentials: { appId, installationId, privateKeyPem },
        mint: githubMintInstallationToken(),
        clock: () => new Date(),
    });
    const http = createGitHubHttpClient({ tokenSource });
    return {
        configSource: githubConfigSource({ client: http, repository }),
        // One call per delivery, so the seam below is bound to exactly the
        // delivery whose evidence it is explaining.
        externals: async ({ payload, deliveryId }) => {
            const outcome = await liveExternalsForDelivery(
                {
                    tokenSource,
                    http,
                    repository,
                    onUnknownOrdering: (detail) => {
                        log({ event: "orderingUnknown", deliveryId, detail });
                    },
                },
                payload,
            );
            if (!outcome.ok) {
                throw new Error(`live externals unavailable: ${outcome.failure.kind}`);
            }
            return { killSwitchActive, ...outcome.facts };
        },
    };
}

const live =
    appId && installationId && privateKeyPath
        ? liveGitHub({ appId, installationId, privateKeyPath })
        : null;
const configSource = live?.configSource ?? fileConfigSource(configFile);
const externals = live?.externals ?? (() => stubbedExternals({ killSwitchActive }));

if (stranded !== null) {
    log({ event: "legacyStoreFound", legacyPath: stranded, storePath: storeFile });
}
const store = new Store(storeFile);
const shell = createShell({
    secret,
    store,
    capabilities: [toEngine(intake), toEngine(prQuality), toEngine(inactivity)],
    configSource,
    externals,
    repository,
    sweepIntervalMs: sweepSeconds * 1000,
    log,
});

// Start recovering anything a previous run left pending before listening.
void shell.drain().catch((error: unknown) => {
    log({ event: "drainFailed", phase: "startup", detail: detailOf(error) });
});
// An undefined host is the unnamed case: node reads it as no host at all.
shell.server.listen(port, host, () => {
    log({
        event: "startup",
        port,
        host: host ?? null,
        repository: `${owner}/${repo}`,
        configSource: live === null ? "local" : "live",
        // Which file, either way: the local copy's path, or the path read
        // from the default branch of the repository named above.
        configPath: live === null ? configFile : CONFIG_PATH,
        storePath: storeFile,
    });
});

/**
 * Stop in the order that loses nothing.
 *
 * The socket closes first, because a delivery accepted after this point
 * would be one nothing left in the process will drain. Idle keep-alive
 * connections are closed with it: they hold no request, and waiting out
 * their timeout would only spend the shutdown budget. The sweep stops
 * next, so no timer claims fresh work on the way out.
 *
 * Then the pass already in flight is joined — NOT a new drain, which
 * would claim exactly the work being abandoned. A claim the process dies
 * holding is invisible for the full fifteen-minute stale window, and that
 * window is the whole cost this ordering buys off; anything still queued
 * is durable and waits for the next start.
 *
 * The store closes last, because every step above it writes.
 */
let stopping = false;
const shutdown = (signal: NodeJS.Signals): void => {
    // A second signal during a shutdown is impatience, not new information.
    if (stopping) return;
    stopping = true;
    void (async () => {
        // close() stops accepting at once; its callback is the LAST
        // connection leaving, which is what the drain below waits behind.
        const closed = new Promise<void>((resolve) => {
            shell.server.close(() => resolve());
            shell.server.closeIdleConnections();
        });
        shell.stopSweep();
        await closed;
        await shell.settled();
        try {
            store.close();
        } catch (error) {
            log({ event: "storeCloseFailed", detail: detailOf(error) });
        }
        log({ event: "shutdown", signal });
        // A write to a pipe is asynchronous and process.exit truncates
        // whatever is still queued. Stream callbacks run in order, so this
        // empty one runs after the line above has actually left.
        process.stdout.write("", () => {
            process.exit(0);
        });
    })();
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
