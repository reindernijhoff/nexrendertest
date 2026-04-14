import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type {AccelParams} from './types.js';
import {execFileAsync} from "./utils.js";


function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Get video duration via ffprobe with retries and fallbacks.
 * Production-hardened: handles freshly-written files, ffprobe flakiness,
 * and falls back to parsing ffmpeg stderr or estimating from file size.
 */
export async function getVideoDuration(filepath: string, maxRetries = 3): Promise<number> {
    if (!fs.existsSync(filepath)) {
        throw new Error(`File not found: ${filepath}`);
    }

    // Small delay to ensure file is fully flushed to disk
    // await sleep(100);

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const {stdout} = await execFileAsync('ffprobe', [
                '-v', 'error',
                '-show_entries', 'format=duration',
                '-of', 'csv=p=0',
                filepath,
            ], {timeout: 30_000});

            const duration = parseFloat(stdout.trim());
            if (!isNaN(duration) && duration > 0) {
                console.log(`  Duration of ${path.basename(filepath)}: ${duration.toFixed(2)}s`);
                return duration;
            }
        } catch (err) {
            console.warn(`  ffprobe attempt ${attempt + 1} failed: ${(err as Error).message}`);
        }

        if (attempt < maxRetries - 1) {
            await sleep(100 + attempt * 500);
        }
    }

    // All retries failed — use fallback method
    console.warn(`  All ffprobe attempts failed for ${path.basename(filepath)}, trying fallback...`);
    return getDurationFallback(filepath);
}

/**
 * Fallback: parse duration from `ffmpeg -i` stderr output.
 * Last resort: estimate from file size.
 */
async function getDurationFallback(filepath: string): Promise<number> {
    try {
        // ffmpeg -i <file> -f null - exits with error but prints duration in stderr
        await execFileAsync('ffmpeg', ['-i', filepath, '-f', 'null', '-'], {timeout: 60_000});
    } catch (err: unknown) {
        const stderr = (err as { stderr?: string }).stderr ?? '';
        const match = stderr.match(/Duration: (\d{2}):(\d{2}):(\d{2}\.\d{2})/);
        if (match) {
            const [, h, m, s] = match;
            const total = parseInt(h) * 3600 + parseInt(m) * 60 + parseFloat(s);
            console.log(`  Fallback duration: ${total.toFixed(2)}s`);
            return total;
        }
    }

    // Last resort: rough estimate from file size (~2MB/s for typical video)
    const stat = fs.statSync(filepath);
    const estimated = Math.max(1.0, stat.size / (1024 * 1024) / 2);
    console.warn(`  Using estimated duration from file size: ${estimated.toFixed(2)}s`);
    return estimated;
}

/**
 * Auto-detect the best encoding acceleration available on this system.
 * Checks NVENC (NVIDIA GPU), QSV (Intel), then falls back to CPU libx264.
 */
let cachedAccel: AccelParams | null = null;

export async function detectAcceleration(): Promise<AccelParams> {
    if (cachedAccel) return cachedAccel;

    try {
        const {stdout} = await execFileAsync('ffmpeg', ['-hide_banner', '-encoders'], {timeout: 10_000});

        // Check NVIDIA NVENC
        if (stdout.includes('h264_nvenc')) {
            try {
                await execFileAsync('ffmpeg', [
                    '-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=1',
                    '-c:v', 'h264_nvenc', '-f', 'null', '-',
                ], {timeout: 5_000});

                console.log('NVENC detected and working');
                cachedAccel = {
                    decoder: ['-hwaccel', 'cuda'],
                    encoder: 'h264_nvenc',
                    preset: 'p2',
                    extraParams: ['-gpu', '0', '-rc', 'vbr', '-cq', '23', '-b:v', '0'],
                };
                return cachedAccel;
            } catch { /* NVENC test failed, continue */
            }
        }

        // Check Intel Quick Sync
        if (stdout.includes('h264_qsv')) {
            try {
                await execFileAsync('ffmpeg', [
                    '-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=1',
                    '-c:v', 'h264_qsv', '-f', 'null', '-',
                ], {timeout: 5_000});

                console.log('Intel Quick Sync detected and working');
                cachedAccel = {
                    decoder: ['-hwaccel', 'qsv'],
                    encoder: 'h264_qsv',
                    preset: 'medium',
                    extraParams: ['-global_quality', '23'],
                };
                return cachedAccel;
            } catch { /* QSV test failed, continue */
            }
        }
    } catch { /* detection failed */
    }

    // Fallback to CPU
    const cpuCount = os.cpus().length;
    console.log(`Using CPU encoding with ${cpuCount} threads`);
    cachedAccel = {
        decoder: [],
        encoder: 'libx264',
        preset: 'faster',
        extraParams: ['-crf', '23', '-threads', String(cpuCount)],
    };
    return cachedAccel;
}

/**
 * Run an ffmpeg command. Throws on non-zero exit code.
 */
export async function runFfmpeg(args: string[]): Promise<{ stdout: string; stderr: string }> {
    const preview = args.slice(0, 12).join(' ');
    console.log(`  ffmpeg ${preview}${args.length > 12 ? '...' : ''}`);

    try {
        return await execFileAsync('ffmpeg', args, {
            timeout: 300_000,
            maxBuffer: 10 * 1024 * 1024,
        });
    } catch (err: unknown) {
        const stderr = (err as { stderr?: string }).stderr ?? '';
        throw new Error(`ffmpeg failed: ${stderr || (err as Error).message}`);
    }
}

/**
 * Check whether a file contains an audio stream.
 */
export async function hasAudioStream(filepath: string): Promise<boolean> {
    try {
        const {stdout} = await execFileAsync('ffprobe', [
            '-v', 'quiet',
            '-select_streams', 'a:0',
            '-show_entries', 'stream=codec_type',
            '-of', 'csv=p=0',
            filepath,
        ], {timeout: 10_000});
        return stdout.includes('audio');
    } catch {
        return false;
    }
}

/**
 * Convert a hex color string (#RRGGBB) to ffmpeg chromakey format (0xRRGGBB).
 */
export function hexToChromaKeyColor(hex: string): string {
    const cleaned = hex.replace('#', '');
    if (cleaned.length !== 6) {
        throw new Error(`Hex color must be 6 characters (e.g. #FF0000), got: ${hex}`);
    }
    return `0x${cleaned}`;
}
