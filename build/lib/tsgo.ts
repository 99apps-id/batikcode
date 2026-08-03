/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import ansiColors from 'ansi-colors';
import * as cp from 'child_process';
import es from 'event-stream';
import fancyLog from 'fancy-log';
import * as fs from 'fs';
import { createRequire } from 'module';
import * as path from 'path';

const root = path.dirname(path.dirname(import.meta.dirname));
const ansiRegex = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
const timestampRegex = /^\[\d{2}:\d{2}:\d{2}\]\s*/;

/**
 * Absolute path to the TypeScript 7 (native) compiler entrypoint. TS7 is
 * installed under the `@typescript/native` alias, a package name that only
 * exists at the repository root and never collides with the `typescript`
 * (<= 6.x) that individual extensions install locally. Resolving it explicitly
 * and invoking it via `node` guarantees we always run TS7, regardless of the
 * node_modules layout of the project being compiled.
 */
const ts7TscPath = path.join(path.dirname(createRequire(import.meta.url).resolve('@typescript/native/package.json')), 'bin', 'tsc');

/**
 * Raised when tsgo failed without emitting any diagnostics. That points at a
 * corrupted or race-damaged incremental cache rather than a type error, so the
 * invocation can be safely retried once after dropping the cache.
 */
class RetryableTsgoError extends Error { }

/**
 * Computes the locations where tsgo may have written the incremental build-info
 * file for `projectPath`. tsgo places it next to the tsconfig file, or inside
 * `outDir` when one is configured (e.g. the client project writes to
 * `out/vs/tsconfig.tsbuildinfo`).
 */
function getStaleBuildInfoCandidates(projectPath: string): string[] {
	const dir = path.dirname(projectPath);
	const configName = path.basename(projectPath, '.json');
	const candidates = [path.join(dir, `${configName}.tsbuildinfo`)];
	try {
		const config = JSON.parse(fs.readFileSync(projectPath, 'utf8')) as { compilerOptions?: { outDir?: string; tsBuildInfoFile?: string } };
		const explicit = config.compilerOptions?.tsBuildInfoFile;
		if (typeof explicit === 'string' && explicit) {
			candidates.push(path.resolve(dir, explicit));
		}
		const outDir = config.compilerOptions?.outDir;
		if (typeof outDir === 'string' && outDir) {
			candidates.push(path.join(dir, outDir, `${configName}.tsbuildinfo`));
		}
	} catch {
		// Unreadable config: keep the default candidate only.
	}
	return candidates;
}

/**
 * Deletes the incremental build-info file(s) for `projectPath`. The build-info
 * is purely a cache — it only makes incremental compiles faster — so removing it
 * is always safe and lets tsgo rebuild it from scratch.
 */
function clearStaleBuildInfo(projectPath: string): void {
	for (const candidate of getStaleBuildInfoCandidates(projectPath)) {
		try {
			fs.rmSync(candidate, { force: true });
		} catch {
			// Best-effort; if the file is locked the retry surfaces the real error.
		}
	}
}

export function spawnTsgo(projectPath: string, config: { taskName: string; noEmit?: boolean }, onComplete?: () => Promise<void> | void): Promise<void> {
	function runReporter(output: string) {
		const lines = (output || '').split('\n');
		const errorLines = lines.filter(line => /error \w+:/.test(line));
		fancyLog(`Finished ${ansiColors.green(config.taskName)} ${projectPath} with ${errorLines.length} errors.`);
		for (const line of errorLines) {
			fancyLog(line);
		}
	}

	const run = (): Promise<void> => new Promise((resolve, reject) => {
		const args = [ts7TscPath, '--project', projectPath, '--pretty', 'false', '--incremental'];
		if (config.noEmit) {
			args.push('--noEmit');
		} else {
			args.push('--sourceMap', '--inlineSources');
		}
		const child = cp.spawn(process.execPath, args, {
			cwd: root,
			stdio: ['ignore', 'pipe', 'pipe']
		});

		let stdoutData = '';
		let stderrData = '';

		child.stdout?.on('data', (data: Buffer) => {
			stdoutData += data.toString();
		});
		child.stderr?.on('data', (data: Buffer) => {
			stderrData += data.toString();
		});

		child.on('exit', code => {
			const allOutput = stdoutData + '\n' + stderrData;
			const lines = allOutput
				.split(/\r?\n/)
				.map(line => line.replace(ansiRegex, '').trim())
				.map(line => line.replace(timestampRegex, ''))
				.filter(line => line.length > 0)
				.filter(line => !/Starting compilation|File change detected|Compilation complete/i.test(line));

			runReporter(lines.join('\n'));

			if (code === 0) {
				Promise.resolve(onComplete?.()).then(() => resolve(), reject);
			} else if (lines.some(line => /error \w+:/.test(line))) {
				// Real diagnostics were emitted — this is a genuine failure, report it.
				reject(new Error(`tsgo exited with code ${code ?? 'unknown'}`));
			} else {
				// tsgo failed without emitting any diagnostics. That points at a
				// corrupted or race-damaged incremental cache (e.g. another tsgo
				// was running on the same project, or a previous run was
				// interrupted). The cache is disposable, so drop it and retry once.
				clearStaleBuildInfo(projectPath);
				reject(new RetryableTsgoError());
			}
		});

		child.on('error', err => {
			reject(err);
		});
	});

	return run().catch(err => {
		if (!(err instanceof RetryableTsgoError)) {
			throw err;
		}
		return run();
	});
}

export function createTsgoStream(projectPath: string, config: { taskName: string; noEmit?: boolean }, onComplete?: () => Promise<void> | void): NodeJS.ReadWriteStream {
	const stream = es.through();

	spawnTsgo(projectPath, config, onComplete).then(() => {
		stream.emit('end');
	}).catch(err => {
		stream.emit('error', err);
	});

	return stream;
}
