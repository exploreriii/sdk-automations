import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
    parseConfig,
    NO_CONFIG,
    labelKey,
    MAPPABLE_MEANINGS,
    REPOSITORY_MODES,
} from "../../src/config/index.js";
import { VALUE_REJECTIONS, expectRejection } from "./documents.js";

/**
 * Property-based tests (fast-check): randomized structured inputs with
 * fixed seeds — deterministic runs, shrinking to minimal counterexamples
 * on failure. They state PROPERTIES the examples below cannot: that the
 * parser never throws and is a fixed point over its generated input space.
 */
const SEED = 20260725;

/**
 * Headroom for the two heavy properties, applied PER TEST rather than to
 * core's vitest config, so a genuine hang anywhere else still fails fast.
 *
 * These two run 300 generated cases each and measure 1.5-1.9 s on an idle
 * machine — a 3x margin under vitest's 5 s default. `pnpm -r test` runs
 * six packages concurrently over core's own parallel workers, and a 3x
 * slowdown there is ordinary, which is the best explanation of the
 * intermittent failures these properties produced across 2026-08-07/08:
 * the seed is FIXED, so the inputs are identical on every run and an
 * input-dependent counterexample is impossible, while a timeout is
 * load-dependent by nature. The earlier "seed-dependent flake" reading
 * was wrong for exactly that reason (D98).
 */
const PROPERTY_TIMEOUT_MS = 30_000;

const camelName = fc.stringMatching(/^[a-z][a-zA-Z0-9]{0,10}$/);

/** Valid-by-construction config: injective labels, camelCase names. */
const validConfig = fc
    .uniqueArray(fc.constantFrom(...MAPPABLE_MEANINGS), { maxLength: MAPPABLE_MEANINGS.length })
    .chain((meanings) =>
        fc
            /**
             * Unique by the VALIDATOR's judgment, not by exact string: the
             * collision rule folds case (D55), so ["Abc", "abc"] is exact-
             * unique yet labelNotInjective — a real collision class the
             * exact-string uniqueness permitted. Same fold, same function,
             * third consumer. (The intermittent failures once blamed on
             * this generator were a timeout, not a counterexample — D98.)
             */
            .uniqueArray(fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9: -]{0,20}[a-zA-Z0-9]$/), {
                selector: labelKey,
                minLength: meanings.length,
                maxLength: meanings.length,
            })
            .map((labels) => Object.fromEntries(meanings.map((m, i) => [m, labels[i]]))),
    )
    .chain((labels) =>
        fc.record(
            {
                schemaVersion: fc.constant(1 as const),
                mode: fc.constantFrom(...REPOSITORY_MODES),
                capabilities: fc.dictionary(
                    camelName,
                    fc.record(
                        {
                            enabled: fc.boolean(),
                            settings: fc.dictionary(camelName, fc.jsonValue()),
                        },
                        { requiredKeys: [] },
                    ),
                    { maxKeys: 5 },
                ),
                mappings: fc.constant({ labels }),
                principals: fc.dictionary(camelName, fc.string(), { maxKeys: 5 }),
            },
            { requiredKeys: ["schemaVersion"] },
        ),
    );

describe("parseConfig properties", () => {
    it("never throws and ok ⇔ no errors, for arbitrary values", () => {
        fc.assert(
            fc.property(fc.anything(), (raw) => {
                const result = parseConfig(raw, { revision: "rev-test", knownCapabilities: [] });
                expect(typeof result.ok).toBe("boolean");
                if (!result.ok) expect(result.errors.length).toBeGreaterThan(0);
                else expect("errors" in result).toBe(false);
            }),
            { seed: SEED, numRuns: 500 },
        );
    });

    it(
        "valid-by-construction configs parse ok",
        () => {
            fc.assert(
                fc.property(validConfig, (raw) => {
                    const result = parseConfig(raw, {
                        revision: "rev-test",
                        knownCapabilities: Object.keys(raw.capabilities ?? {}),
                    });
                    if (!result.ok) throw new Error(result.errors.map((e) => e.message).join("; "));
                }),
                { seed: SEED, numRuns: 300 },
            );
        },
        PROPERTY_TIMEOUT_MS,
    );

    it(
        "is a fixed point: re-parsing an accepted config yields the identical config",
        () => {
            // Catches silent normalization drift — whatever parseConfig
            // outputs must be exactly what it would output again.
            fc.assert(
                fc.property(validConfig, (raw) => {
                    const knownCapabilities = Object.keys(raw.capabilities ?? {});
                    const first = parseConfig(raw, { revision: "rev-test", knownCapabilities });
                    if (!first.ok) return; // covered by the property above
                    /**
                     * `revision` is metadata ABOUT the document, not a key IN
                     * it (D77), so a parsed configuration is no longer a valid
                     * document — it carries a field a maintainer never writes.
                     * Stripping it keeps the property meaningful: what parsing
                     * produces, minus the identity stamped on it, must parse
                     * back to the same thing.
                     */
                    const { revision: _stamped, ...asDocument } = first.config;
                    const second = parseConfig(asDocument as unknown, {
                        revision: "rev-test",
                        knownCapabilities,
                    });
                    expect(second.ok).toBe(true);
                    if (second.ok) expect(second.config).toEqual(first.config);
                }),
                { seed: SEED, numRuns: 300 },
            );
        },
        PROPERTY_TIMEOUT_MS,
    );
});

/**
 * Every way an already-parsed value is wrong, from `documents.ts`. The rows
 * were hand-written `it()`s here and in `adversarial.test.ts` until the two
 * files had drifted into three overlapping catalogues of the same thirteen
 * codes; what remains below is only what a row cannot say.
 */
describe("parseConfig rejections (design/config/schema.md)", () => {
    it.each(VALUE_REJECTIONS.map((r) => [`${r.code}: ${r.why}`, r] as const))(
        "%s",
        (_name, rejection) => {
            expectRejection(
                parseConfig(rejection.raw, {
                    revision: "rev-test",
                    knownCapabilities: rejection.known ?? [],
                }),
                rejection,
            );
        },
    );
});

describe("parseConfig acceptances (design/config/schema.md)", () => {
    it("no configuration yields the safe default — observe mode, nothing enabled (§2.2)", () => {
        for (const raw of [undefined, null]) {
            const result = parseConfig(raw, { revision: "rev-test", knownCapabilities: [] });
            /**
             * The safe default still carries the revision it was read at
             * (D77): "there was no file at this commit" is a fact worth
             * keeping, and an operator report that cannot say WHEN nothing
             * was found is not evidence of anything.
             */
            expect(result).toEqual({
                ok: true,
                config: { ...NO_CONFIG, revision: "rev-test" },
            });
        }
        // Assert NO_CONFIG's literal shape, not just against itself —
        // a mutation of the constant must fail HERE, not vanish into
        // both sides of the equality above.
        expect(NO_CONFIG.mode).toBe("observe");
        expect(Object.keys(NO_CONFIG.capabilities)).toHaveLength(0);
        expect(Object.keys(NO_CONFIG.principals)).toHaveLength(0);
        expect(NO_CONFIG.mappings).toEqual({ labels: {} });
        expect(NO_CONFIG.schemaVersion).toBe(1);
    });

    it("accepts the documented candidate shape (§3)", () => {
        const result = parseConfig(
            {
                schemaVersion: 1,
                mode: "observe",
                capabilities: {
                    prQuality: {
                        enabled: true,
                        settings: { checks: { dco: true, mergeConflict: true } },
                    },
                    assignment: { enabled: false, settings: { maxOpenAssignments: 2 } },
                },
                mappings: {
                    labels: {
                        ready: "status: ready for dev",
                        inProgress: "status: in progress",
                    },
                },
                principals: { maintainerTeam: "hiero-sdk-cpp-maintainers" },
            },
            { revision: "rev-test", knownCapabilities: ["prQuality", "assignment"] },
        );
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.config.capabilities.prQuality?.enabled).toBe(true);
            expect(result.config.capabilities.assignment?.enabled).toBe(false);
            expect(result.config.mappings.labels.ready).toBe("status: ready for dev");
        }
    });

    /**
     * §2.4's other half. The corpus holds the three truthy values that are
     * NOT consent; this holds the one shape that is silence — and silence
     * means disabled, not enabled.
     */
    it("an omitted enabled leaves the capability off, not on", () => {
        const result = parseConfig(
            { schemaVersion: 1, capabilities: { intake: { settings: {} } } },
            { revision: "rev-test", knownCapabilities: ["intake"] },
        );
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.config.capabilities.intake?.enabled).toBe(false);
    });

    /**
     * The other side of D55: the fold decides COLLISION only. Two labels that
     * genuinely differ both survive, spelt exactly as the maintainer wrote
     * them, because that spelling is what the App writes to GitHub.
     */
    it("genuinely distinct labels still pass, with their spelling preserved", () => {
        const result = parseConfig(
            {
                schemaVersion: 1,
                mappings: {
                    labels: { ready: "Status: Ready", needsReview: "status: needs review" },
                },
            },
            { revision: "rev-test", knownCapabilities: [] },
        );
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.config.mappings.labels.ready).toBe("Status: Ready");
    });

    // D56 — an absent key defaults; the corpus holds the present-but-empty
    // half, which is an error rather than a default.
    it("an absent mode defaults to observe", () => {
        const result = parseConfig(
            { schemaVersion: 1 },
            { revision: "rev-test", knownCapabilities: [] },
        );
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.config.mode).toBe("observe");
    });
});

describe("NO_CONFIG is inert all the way down", () => {
    it("carries the empty revision — the parser stamps the real one", () => {
        // `parseConfig` spreads NO_CONFIG and overwrites `revision` from its
        // options, so this literal is only ever visible to code that uses
        // NO_CONFIG directly — which must be able to tell it from any parsed
        // configuration, and "" is that sentinel.
        expect(NO_CONFIG.revision).toBe("");
    });
});
