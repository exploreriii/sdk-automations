/**
 * The composition root: receiver + store + the two lanes wired into one running shell.
 * Every box is existing, gated code; this file's whole contribution is ORDER.
 * Plus one clock — a webhook arrival is the only other thing that ever drains, so
 * the sweep is what makes stale work recover on its own in a quiet repository.
 */

import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
    validateCapabilityDeclarations,
    type EngineCapability,
    type RepositoryRef,
} from "@hiero-hackers/automation-core";
import type { Store } from "../../store/index.js";
import type { Applier } from "../apply/apply.js";
import type { ConfigSource } from "../decide/config.js";
import { createItemDecider } from "../decide/item.js";
import type { ExternalsForDelivery } from "../decide/externals.js";
import { createDeliveries } from "../inbound/deliveries.js";
import { createReceiver } from "../inbound/receiver.js";
import { createJobs } from "../jobs/jobs.js";
import { contained, createLogger, detailOf, type Log } from "../log.js";
import { DEFAULT_SWEEP_CADENCE_MS, SWEEP_READ_BUDGET, SWEEP_WRITE_CAP } from "../sweep/budgets.js";
import { createSweep, type SweepFactsSource } from "../sweep/sweep.js";

/** How often the shell requeues stale claims and drains, absent an override. */
export const DEFAULT_TICK_MS = 60_000;

/**
 * How long one connection may hold the edge open; Node's defaults are a slow-loris budget.
 * GitHub abandons a delivery unanswered for about ten seconds and redelivers later.
 */
const REQUEST_TIMEOUT_MS = 30_000;
const HEADERS_TIMEOUT_MS = 10_000;

export interface ShellOptions {
    readonly secret: string;
    readonly store: Store;
    readonly capabilities: readonly EngineCapability[];
    readonly configSource: ConfigSource;
    readonly externals: ExternalsForDelivery;
    readonly repository: RepositoryRef;
    readonly worker?: string;
    readonly clock?: () => Date;
    readonly tickMs?: number;
    /** The write path, when one is wired; with none, active mode is refused before `decide()`. */
    readonly applier?: Applier;
    /** The fact sweep, when a composition has something to read GitHub with. Absent is the shipped composition: due `sweep:` rows are simply never claimed. */
    readonly sweep?: {
        readonly facts: SweepFactsSource;
        /** How long until the next firing; the default is hourly. */
        readonly cadenceMs?: number;
        /** How many writes one firing may send; the default is `SWEEP_WRITE_CAP`. */
        readonly writeCap?: number;
        /** How many requests one firing may spend reading; the default is `SWEEP_READ_BUDGET`. */
        readonly readBudget?: number;
        /** What that budget is spent against: the client's own count of requests sent. */
        readonly requestsMade: () => number;
    };
    /** The installation switch (D171): deliveries are accepted and recorded, and nothing is read, decided or sent. */
    readonly suspended?: boolean;
    /** Optional here and required of every component: the root defaults to the production log. */
    readonly log?: Log;
}

export interface Shell {
    readonly server: Server;
    /** Pump everything pending — exposed so tests and operators drain deterministically. */
    drain(): Promise<void>;
    /** The drain in flight, if there is one. Starts no work. */
    settled(): Promise<void>;
    /** Stop the sweep. The server stays the caller's to close. */
    stopTick(): void;
}

export function createShell(options: ShellOptions): Shell {
    const errors = validateCapabilityDeclarations(
        options.capabilities.map(({ declaration }) => declaration),
    );
    if (errors.length > 0) {
        throw new Error(`invalid capability declarations: ${errors.join("; ")}`);
    }
    const clock = options.clock ?? (() => new Date());
    const suspended = options.suspended ?? false;
    const log = contained(options.log ?? createLogger({ clock }));
    const decideItem = createItemDecider({
        store: options.store,
        capabilities: options.capabilities,
        externals: options.externals,
        repository: options.repository,
        ...(options.applier === undefined ? {} : { applier: options.applier }),
    });
    const deliveries = createDeliveries({
        store: options.store,
        capabilities: options.capabilities,
        configSource: options.configSource,
        decideItem,
        repository: options.repository,
        worker: options.worker ?? `shell-${randomUUID()}`,
        clock,
        log,
        suspended,
    });
    /**
     * It rides the reconciliation tick rather than owning a timer: the schedule row's DUE
     * DATE decides when a repository is read, so a second interval is a second thing to stop.
     */
    const factSweep =
        options.sweep === undefined
            ? null
            : createSweep({
                  store: options.store,
                  capabilities: options.capabilities,
                  processor: { decideItem, configuration: deliveries.configuration },
                  facts: options.sweep.facts,
                  clock,
                  cadenceMs: options.sweep.cadenceMs ?? DEFAULT_SWEEP_CADENCE_MS,
                  writeCap: options.sweep.writeCap ?? SWEEP_WRITE_CAP,
                  readBudget: options.sweep.readBudget ?? SWEEP_READ_BUDGET,
                  requestsMade: options.sweep.requestsMade,
                  suspended,
                  log,
              });
    const handler = createReceiver({
        secret: options.secret,
        log,
        accept: ({ deliveryId, eventName, payload }) =>
            options.store.inbox.acceptDelivery({
                deliveryId,
                eventName,
                payload,
                receivedAt: clock().toISOString(),
            }).outcome,
        onAccepted: () => {
            void deliveries.drain().catch((error: unknown) => {
                log({ event: "drainFailed", phase: "accepted", detail: detailOf(error) });
            });
        },
    });
    const jobs = createJobs({
        store: options.store,
        deliveries,
        sweep: factSweep,
        clock,
        suspended,
        log,
        ...(options.applier === undefined ? {} : { applier: options.applier }),
    });
    const ticking = setInterval(jobs.tick, options.tickMs ?? DEFAULT_TICK_MS);
    // Stryker disable next-line CallExpression: unref only decides whether an otherwise-idle event loop keeps running; nothing in this process can observe it, and the shell's own exit is explicit.
    // The sweep is recovery, never a reason for the process to stay alive.

    ticking.unref();

    const server = createServer(handler);
    server.requestTimeout = REQUEST_TIMEOUT_MS;
    server.headersTimeout = HEADERS_TIMEOUT_MS;

    return {
        server,
        drain: () => deliveries.drain(),
        settled: () => jobs.settled(),
        stopTick: () => {
            clearInterval(ticking);
        },
    };
}
