import type {VideoSegment} from "./types.js";
import fs from "node:fs";
import {promisify} from "node:util";
import {execFile} from "node:child_process";

export const execFileAsync = promisify(execFile) as (
    file: string,
    args: string[],
    options: { timeout?: number },
) => Promise<{ stdout: string; stderr: string }>;

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
            if (fs.existsSync(f)) {
                fs.unlinkSync(f);
                removed++;
            }
        } catch { /* ignore */
        }
    }
    console.log(`Cleanup: removed ${removed} temp files`);
}


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

export async function runParallel(tasks: (() => Promise<void>)[], concurrency: number): Promise<void> {
    let active = 0;
    let index = 0;
    const errors: Error[] = [];

    await new Promise<void>((resolve) => {
        const next = () => {
            while (active < concurrency && index < tasks.length) {
                const task = tasks[index++];
                active++;
                task()
                    .catch((err) => errors.push(err as Error))
                    .finally(() => {
                        active--;
                        if (index < tasks.length) next();
                        else if (active === 0) resolve();
                    });
            }
            if (tasks.length === 0) resolve();
        };
        next();
    });

    if (errors.length > 0) {
        throw new Error(`${errors.length} download(s) failed:\n${errors.map(e => e.message).join('\n')}`);
    }
}