/** What prQuality is woken for, reads, asks and may do — the declaration alone, so `rows.ts` and `capability.ts` share it without a cycle. */

import { declareCapability, type PlatformHandle } from "@hiero-hackers/automation-core/author";
import { PR_QUALITY_SETTINGS } from "./settings.js";

export const prQualityDeclaration = declareCapability({
    name: "prQuality",
    triggers: [
        { kind: "event", event: "pull_request" },
        { kind: "schedule", description: "hourly recheck of every open pull request" },
    ],
    needs: ["readiness"],
    settings: PR_QUALITY_SETTINGS,
    resolvers: [
        "isAutomationActor",
        "linkedIssues",
        "commitAttestations",
        "mergeability",
        "assigneesOf",
    ],
    intents: ["postManagedComment", "applyMappedLabel"],
});

export type PrQualityDeclaration = typeof prQualityDeclaration;

export type Platform = PlatformHandle<PrQualityDeclaration>;
