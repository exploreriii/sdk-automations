/**
 * `design/contracts/config-schema.md` is locked to the vocabularies the code owns,
 * the same bargain doc-drift makes for the taxonomy: a spec a check reads is a
 * contract, a spec nothing reads is a proposal wearing one's name. Two claims:
 * the §4 modes table lists exactly `REPOSITORY_MODES`, and every top-level key
 * the parser accepts appears in the document. The reverse direction — every
 * key the doc shows exists in code — stays with the YAML examples' own test
 * (`examples.test.ts`); prose YAML fragments here are illustrative, not
 * parseable configs. One invariant per file (D89).
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPOSITORY_MODES, TOP_LEVEL_KEYS } from "@hiero-hackers/automation-core";
import { repoRoot } from "./repository.js";

const DOC = join(repoRoot, "design", "contracts", "config-schema.md");

/** The first backtick-quoted token of each row in one `## section`'s table. */
export function tableCodes(markdown: string, heading: string): string[] {
    const section = markdown.split(/^## /m).find((s) => s.startsWith(heading));
    expect(section, `section "${heading}" exists`).toBeDefined();
    return [...(section ?? "").matchAll(/^\|\s*`([a-zA-Z-]+)`\s*\|/gm)].map((m) => m[1]!);
}

describe("contracts/config-schema.md matches the vocabularies the code owns", () => {
    const doc = readFileSync(DOC, "utf8");

    it("the modes table lists exactly the repository modes, in order", () => {
        expect(tableCodes(doc, "4. Repository modes")).toEqual([...REPOSITORY_MODES]);
    });

    it("every top-level key the parser accepts appears in the document", () => {
        const missing = TOP_LEVEL_KEYS.filter(
            (key) => !doc.includes(`\`${key}\``) && !new RegExp(`^${key}:`, "m").test(doc),
        );
        expect(missing).toEqual([]);
    });

    it("proves the check can fail", () => {
        const forged = "## 4. Repository modes\n\n| Mode |\n|---|\n| `disabled` |\n| `observe` |\n";
        expect(tableCodes(`# x\n\n${forged}`, "4. Repository modes")).not.toEqual([
            ...REPOSITORY_MODES,
        ]);
        expect(TOP_LEVEL_KEYS.filter((k) => !"no such key here".includes(k))).not.toEqual([]);
    });
});
