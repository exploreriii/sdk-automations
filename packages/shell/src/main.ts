/**
 * The sandbox-era entry point: environment in, listening shell out.
 *
 * The probes are wired as the capabilities because they are the
 * capabilities that exist; production capabilities replace this ONE
 * import, not the shell. Everything else is env-driven with data/ (never
 * tracked) as the default home for the store and the config copy.
 *
 * Run:
 *   WEBHOOK_SECRET=… REPO_OWNER=… REPO_NAME=… pnpm --filter @hiero-hackers/automation-shell start
 */

import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { toEngine } from "@hiero-hackers/automation-core";
import { Store } from "@hiero-hackers/automation-store";
import { inactivity, intake, prQuality } from "@hiero-hackers/automation-probes";
import {
    createGitHubHttpClient,
    createTokenSource,
    githubMintInstallationToken,
    liveExternalsForDelivery,
} from "@hiero-hackers/automation-adapter";
import { createShell } from "./shell.js";
import { CONFIG_PATH, fileConfigSource } from "./config.js";
import { stubbedExternals, type ExternalsForDelivery } from "./externals.js";

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

const dataDir = fileURLToPath(new URL("../data/", import.meta.url));
mkdirSync(dataDir, { recursive: true });
const configFile = env["CONFIG_FILE"] ?? `${dataDir}automations.yml`;
const storeFile = env["STORE_PATH"] ?? `${dataDir}shell.sqlite`;
const port = Number(env["PORT"] ?? 8790);
// Unnamed by default, which is what binds the unspecified address —
// dual-stack on an IPv6-capable host, where "0.0.0.0" would be IPv4 only.
// A test or a sandbox names the loopback.
const host = env["HOST"];

const killSwitchActive = env["KILL_SWITCH"] === "1";
const repository = { owner, repo };

// THE one conditional D93 promised: App credentials present composes the
// live externals, their absence composes the stubs. CI never holds a
// credential, so CI runs the stub path permanently.
const appId = env["APP_ID"];
const installationId = env["INSTALLATION_ID"];
const privateKeyFile = env["PRIVATE_KEY_FILE"];
let externals: ExternalsForDelivery;
if (appId && installationId && privateKeyFile) {
    const tokenSource = createTokenSource({
        credentials: { appId, installationId, privateKeyPem: readFileSync(privateKeyFile, "utf8") },
        mint: githubMintInstallationToken(),
        clock: () => new Date(),
    });
    const http = createGitHubHttpClient({ tokenSource });
    externals = async ({ payload }) => {
        const outcome = await liveExternalsForDelivery({ tokenSource, http, repository }, payload);
        if (!outcome.ok) {
            // Rejecting releases the processor's claim; the delivery retries.
            throw new Error(`live externals unavailable: ${outcome.failure.kind}`);
        }
        return { killSwitchActive, ...outcome.facts };
    };
} else {
    externals = () => stubbedExternals({ killSwitchActive });
}

const shell = createShell({
    secret,
    store: new Store(storeFile),
    capabilities: [toEngine(intake), toEngine(prQuality), toEngine(inactivity)],
    // An operator-maintained copy of the repository's CONFIG_PATH file;
    // the read-only adapter later fetches the live one behind this seam.
    configSource: fileConfigSource(configFile),
    externals,
    repository,
});

// Start recovering anything a previous run left pending before listening.
void shell.drain().catch((error) => {
    console.error("shell: startup drain failed; inspect durable store state", error);
});
// An undefined host is the unnamed case: node reads it as no host at all.
shell.server.listen(port, host, () => {
    console.log(
        `shell listening on :${port} for ${owner}/${repo} (config copy of ${CONFIG_PATH}: ${configFile}); canonical reports stored in ${storeFile}`,
    );
});
