import type {VideoSegment} from "./types.js";
import fs from "node:fs";

export function cleanupTempFiles(
    segments: VideoSegment[],
    transitions: (string | null)[],
    extras: (string | null | undefined)[],
) {
    const files = new Set<string>();

    for (const seg of segments) {
        if (seg.first) files.add(seg.first);
        if (seg.middle) files.add(seg.middle);
        if (seg.last) files.add(seg.last);
    }
    for (const t of transitions) {
        if (t) files.add(t);
    }
    for (const f of extras) {
        if (f) files.add(f);
    }

    let removed = 0;
    for (const f of files) {
        try {
            if (fs.existsSync(f)) { fs.unlinkSync(f); removed++; }
        } catch { /* ignore */ }
    }
    console.log(`Cleanup: removed ${removed} temp files`);
}


// ---------------------------------------------------------------------------
// Concurrency helper (avoids external dependency)
// ---------------------------------------------------------------------------

export function pLimit(concurrency: number) {
    let active = 0;
    const queue: (() => void)[] = [];

    return <T>(fn: () => Promise<T>): Promise<T> => {
        return new Promise<T>((resolve, reject) => {
            const run = () => {
                active++;
                fn()
                    .then(resolve, reject)
                    .finally(() => {
                        active--;
                        if (queue.length > 0) queue.shift()!();
                    });
            };
            if (active < concurrency) run();
            else queue.push(run);
        });
    };
}