/**
 * Shared by every check: where the repository is, and what packages it holds.
 * Split out of the original repo-artifacts.test.ts when the invariants became
 * one-file-per-invariant (D89).
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Four levels: test/ → checks/ → dev/ → packages/ → the repository root.
export const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

/** Use one representation for paths reported by Node and Git on every OS. */
export function normalizeRepoPath(path: string): string {
    return path.replaceAll("\\", "/");
}

/** Make parsing independent of the checkout's configured line endings. */
export function normalizeNewlines(text: string): string {
    return text.replace(/\r\n?/g, "\n");
}

export function lines(text: string): string[] {
    return normalizeNewlines(text).split("\n");
}

/** Repository invariants inspect versioned material, not local worktree output. */
export function trackedFiles(): string[] {
    return execFileSync("git", ["ls-files", "-z"], {
        cwd: repoRoot,
        encoding: "utf8",
    })
        .split("\0")
        .filter(Boolean)
        .map(normalizeRepoPath);
}

/**
 * Package list comes from the workspace file rather than a hard-coded array,
 * so this keeps working when `probes/` is deleted at stage four and when
 * later packages arrive. A test that needs editing to stay correct is a test
 * that quietly stops being run.
 */
export function workspacePackages(): string[] {
    const yaml = readFileSync(join(repoRoot, "pnpm-workspace.yaml"), "utf8");
    return lines(yaml)
        .map((line) => /^\s*-\s*(.+?)\s*$/.exec(line)?.[1])
        .filter((name): name is string => name !== undefined);
}

/** A document and its text, the pair every reference check scans. */
export interface Document {
    readonly doc: string;
    readonly text: string;
}

/** Every tracked markdown file, read. The corpus for any check about prose. */
export function markdownDocuments(): Document[] {
    return trackedFiles()
        .filter((path) => path.endsWith(".md"))
        .map((path) => ({ doc: path, text: readFileSync(join(repoRoot, path), "utf8") }));
}

/**
 * Every TypeScript file under the named directories of every workspace
 * package, repository-relative. Package list from the workspace file for the
 * reason `workspacePackages` exists: a hard-coded one leaves a newly arrived
 * package unscanned, and a check nobody edits is a check that stopped running.
 */
export function sourceFiles(directories: readonly string[] = ["src", "test"]): string[] {
    const found: string[] = [];
    for (const workspacePackage of workspacePackages()) {
        for (const directory of directories) {
            let entries: string[];
            try {
                entries = readdirSync(join(repoRoot, workspacePackage, directory), {
                    recursive: true,
                }) as string[];
            } catch {
                continue; // a package need not have every directory
            }
            found.push(
                ...entries
                    .map(normalizeRepoPath)
                    .filter((path) => path.endsWith(".ts"))
                    .map((path) => `${workspacePackage}/${directory}/${path}`),
            );
        }
    }
    return found;
}
