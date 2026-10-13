/**
 * Reading the command mapping in the direction a comment speaks it: which command
 * a comment body issued. A word no command maps to answers `null`, never a guess.
 */

import { labelKey } from "./labels.js";
import { COMMANDS, type Command, type RepositoryConfig } from "./schema.js";

/** The marker a line opens or closes a fenced code block with, or `null`. */
function fenceOf(line: string): "```" | "~~~" | null {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) return "```";
    return trimmed.startsWith("~~~") ? "~~~" : null;
}

/** The lines outside every fenced code block; an unclosed fence runs to the end. */
function linesOutsideFences(body: string): readonly string[] {
    const outside: string[] = [];
    let open: "```" | "~~~" | null = null;
    for (const line of body.split("\n")) {
        const marker = fenceOf(line);
        if (open === null) {
            if (marker === null) outside.push(line);
            else open = marker;
        } else if (marker === open) {
            open = null;
        }
    }
    return outside;
}

/** Four columns of indent, or a tab reaching them, make a line indented code. */
const INDENTED_CODE = /^(?: {4}| {0,3}\t)/;

/**
 * The command a comment body invokes, or `null`: the mapped word as the FIRST token of
 * a line outside every code block, fenced or indented, so a quoted `/assign` runs nothing.
 */
export function commandInComment(config: RepositoryConfig, body: string): Command | null {
    for (const line of linesOutsideFences(body)) {
        if (INDENTED_CODE.test(line)) continue;
        const first = labelKey(line).split(/\s+/)[0];
        if (first === undefined || first === "") continue;
        for (const command of COMMANDS) {
            const spelling = config.mappings.commands[command];
            if (spelling !== undefined && labelKey(spelling) === first) return command;
        }
    }
    return null;
}
