import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import config from '../../config/config.js';
import { child } from '../../core/logger.js';
import { UserError } from '../../utils/errors.js';

/**
 * Thin ffmpeg runner. ffmpeg is optional (often missing on Render, `pkg install ffmpeg` on Termux):
 * hasFfmpeg() detects it once, and every conversion fails with a clear message when it is absent.
 * Arguments are passed as an array (no shell), files live in a private temp dir removed afterwards.
 */

const log = child('ffmpeg');
const TIMEOUT_MS = 90_000;
let detected = null;

const run = (args, { timeoutMs = TIMEOUT_MS } = {}) =>
    new Promise((resolve, reject) => {
        let stderr = '';
        let proc;
        try {
            proc = spawn(config.media.ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        } catch (error) {
            reject(error);
            return;
        }
        const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
        proc.stderr.on('data', (d) => {
            stderr = (stderr + d).slice(-2000);
        });
        proc.on('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
        proc.on('close', (code) => {
            clearTimeout(timer);
            if (code === 0) resolve();
            else reject(new Error(`ffmpeg exited with ${code}: ${stderr.split('\n').filter(Boolean).slice(-2).join(' | ')}`));
        });
    });

/** True when the ffmpeg binary can be started (cached after the first check). */
export const hasFfmpeg = async () => {
    if (detected !== null) return detected;
    detected = await run(['-hide_banner', '-version'], { timeoutMs: 10_000 }).then(
        () => true,
        () => false
    );
    if (!detected) log.warn('ffmpeg not found: media conversion commands are limited. Set FFMPEG_PATH or install ffmpeg.');
    return detected;
};

/** Throws a user-facing error when ffmpeg is missing. */
export const requireFfmpeg = async () => {
    if (!(await hasFfmpeg())) throw new UserError('This needs ffmpeg, which is not installed on this server (Termux: pkg install ffmpeg).');
};

/**
 * Converts a buffer: writes it to a temp file, runs ffmpeg with `args(input, output)`, returns the output.
 * @param {Buffer} input
 * @param {{ inExt: string, outExt: string, args: (input: string, output: string) => string[] }} options
 */
export const convert = async (input, { inExt, outExt, args, timeoutMs }) => {
    await requireFfmpeg();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'neo-'));
    const id = crypto.randomBytes(6).toString('hex');
    const src = path.join(dir, `${id}.${inExt}`);
    const out = path.join(dir, `${id}-out.${outExt}`);
    try {
        await writeFile(src, input);
        await run(['-hide_banner', '-loglevel', 'error', '-y', ...args(src, out)], { timeoutMs });
        return await readFile(out);
    } catch (error) {
        if (error?.expose) throw error;
        log.warn(error.message);
        throw new UserError('Conversion failed. Try another file.');
    } finally {
        rm(dir, { recursive: true, force: true }).catch(() => {});
    }
};

/** Test hook: forget the cached detection. */
export const resetFfmpegDetection = () => {
    detected = null;
};
