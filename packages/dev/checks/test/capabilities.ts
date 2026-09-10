/**
 * The capabilities the shipped shell admits, read out of their SOURCE TEXT.
 *
 * This package depends on core's barrel and nothing downstream of it (D85),
 * so a capability is a file to open rather than an import. Two checks read
 * the same list — the examples are parsed against it, and the table in
 * `docs/capabilities.md` is generated from it — and two derivations of one
 * list would let a capability quietly fall out of one side.
 *
 * A capability is one FOLDER (D131), and which file inside it carries the
 * declaration is that capability's own business — `inactivity` keeps its
 * declaration below the ladders that are typed against it. Reading the folder
 * rather than a fixed filename is what keeps this about the shipped list
 * instead of about a layout. The registry decides membership: `main.ts`
 * composes `CAPABILITIES` and names no capability.
 *
 * Throws rather than expecting: `generate.ts` runs this under `tsx`, where no
 * test runner is listening, and a shipped capability the reader cannot make
 * sense of must stop the generator rather than print a table with a hole.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DeclaredTrigger, RequiredMappings } from "@hiero-hackers/automation-core";
import { normalizeNewlines, repoRoot, sourceFiles } from "./repository.js";

/** One shipped capability, as its folder declares it. */
export interface ShippedCapability {
    /** The registry identifier — the binding `toEngine(...)` wraps. */
    readonly binding: string;
    readonly name: string;
    /** Repository-relative folder, `packages/capabilities/src/<name>`. */
    readonly folder: string;
    readonly triggers: readonly DeclaredTrigger[];
    readonly configKeys: readonly string[];
    readonly requiredMappings: RequiredMappings;
    readonly intents: readonly string[];
    /** The design page's title after its name — what the capability is for. */
    readonly purpose: string;
}

const read = (path: string) => normalizeNewlines(readFileSync(join(repoRoot, path), "utf8"));

/** The quoted names in one flat `field: [...]` list of a declaration. */
function declaredList(text: string, field: string): string[] {
    const body = new RegExp(`${field}: \\[([^\\]]*)\\]`).exec(text)?.[1] ?? "";
    return [...body.matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]!);
}

/**
 * The families a declaration's `requiredMappings` object states, and the names
 * inside each. An object with no family states nothing, which is a declaration
 * demanding no mapping at all.
 */
function declaredMappings(text: string): RequiredMappings {
    const body = /requiredMappings: \{([^}]*)\}/.exec(text)?.[1] ?? "";
    return Object.fromEntries(
        [...body.matchAll(/([a-z]+): \[([^\]]*)\]/g)].map((family) => [
            family[1]!,
            [...family[2]!.matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]!),
        ]),
    ) as RequiredMappings;
}

/** The `triggers` list: each entry is an event by name or a schedule by description. */
function declaredTriggers(text: string): DeclaredTrigger[] {
    const body = /triggers: \[([^\]]*)\]/.exec(text)?.[1] ?? "";
    const events = [...body.matchAll(/kind:\s*"event",\s*event:\s*"([a-z_]+)"/g)].map(
        (m): DeclaredTrigger => ({ kind: "event", event: m[1]! }),
    );
    const schedules = [...body.matchAll(/kind:\s*"schedule",\s*description:\s*"([^"]*)"/g)].map(
        (m): DeclaredTrigger => ({ kind: "schedule", description: m[1]! }),
    );
    return [...events, ...schedules];
}

/**
 * The sentence after the dash in the design page's title — `# intake — walk a
 * new issue …`. The page is the standard the capability is built to (D131),
 * so its title is where the purpose is owned, and the one place a generator
 * may take a sentence from.
 */
function designPurpose(folder: string): string {
    const page = join(repoRoot, folder, "design.md");
    if (!existsSync(page)) throw new Error(`${folder} has no design.md`);
    const title = normalizeNewlines(readFileSync(page, "utf8")).split("\n")[0] ?? "";
    const purpose = /^# [A-Za-z-]+ — (.+)$/.exec(title)?.[1];
    if (purpose === undefined)
        throw new Error(`${folder}/design.md's title is not "# name — purpose"`);
    return purpose;
}

/** Every capability folder's source, read as one text. */
function capabilityFolders(): { readonly folder: string; readonly text: string }[] {
    const byFolder = new Map<string, string[]>();
    for (const path of sourceFiles(["src"])) {
        const folder = /^(packages\/capabilities\/src\/[A-Za-z]+)\/[A-Za-z-]+\.ts$/.exec(path)?.[1];
        if (folder === undefined || path.endsWith(".test.ts")) continue;
        byFolder.set(folder, [...(byFolder.get(folder) ?? []), read(path)]);
    }
    return [...byFolder].map(([folder, texts]) => ({ folder, text: texts.join("\n") }));
}

/** Each folder's declaration, keyed by the binding the registry would name. */
function declarations(): Map<string, ShippedCapability> {
    const byBinding = new Map<string, ShippedCapability>();
    for (const { folder, text } of capabilityFolders()) {
        const name = /declareCapability\(\{\s*name: "([A-Za-z]+)"/.exec(text)?.[1];
        const binding = /export const ([A-Za-z]+): Capability</.exec(text)?.[1];
        if (name === undefined || binding === undefined) {
            throw new Error(`${folder} declares no capability the registry could list`);
        }
        byBinding.set(binding, {
            binding,
            name,
            folder,
            triggers: declaredTriggers(text),
            configKeys: declaredList(text, "configKeys"),
            requiredMappings: declaredMappings(text),
            intents: declaredList(text, "intents"),
            purpose: designPurpose(folder),
        });
    }
    return byBinding;
}

/**
 * The identifiers the registry lists, in production order. Anchored on the
 * declaration, not on where the `[` falls: the list carries a type annotation,
 * which is itself bracketed. Each entry is wrapped in the engine erasure, so
 * the binding is what that call names.
 */
function registeredBindings(): string[] {
    const index = read("packages/capabilities/src/index.ts");
    const list = /export const CAPABILITIES[^=]*=\s*\[([^\]]*)\]/.exec(index)?.[1] ?? "";
    return [...list.matchAll(/toEngine\(([A-Za-z]+)\)/g)].map((m) => m[1]!);
}

/**
 * The shipped capabilities in registry order — the order the shell evaluates
 * them in, and the order the documentation lists them.
 *
 * A hand-typed literal here was the defect: it named `assignment`, which no
 * capability declares, so an example the real shell would reject parsed clean.
 * The examples check carries the negative control for the other half (D8).
 */
export function shippedCapabilities(): readonly ShippedCapability[] {
    const declared = declarations();
    const bindings = registeredBindings();
    if (bindings.length === 0) throw new Error("the registry lists no capability");
    return bindings.map((binding) => {
        const capability = declared.get(binding);
        if (capability === undefined) {
            throw new Error(`${binding} is listed by the registry and declared by no folder`);
        }
        return capability;
    });
}

/** Every folder that declares a capability, listed by the registry or not. */
export function declaredCapabilityNames(): readonly string[] {
    return [...declarations().values()].map(({ name }) => name).sort();
}
