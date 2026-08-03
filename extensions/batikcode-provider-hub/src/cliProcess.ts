/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { access } from 'fs/promises';

export interface CliInvocation {
	readonly target: string;
	readonly args: readonly string[];
}

export function createCliInvocation(
	executable: string,
	args: readonly string[],
	platform = process.platform,
	commandProcessor = process.env.ComSpec || 'cmd.exe'
): CliInvocation {
	if (platform === 'win32' && /\.(?:bat|cmd)$/i.test(executable)) {
		// `cmd /c call <script> <args>` lets Node quote every argv entry itself.
		// Wrapping the complete command in another pair of quotes makes cmd.exe
		// interpret the entire command line as one executable name.
		return {
			target: commandProcessor,
			args: ['/d', '/c', 'call', executable, ...args]
		};
	}
	return { target: executable, args };
}

export function normalizeWorkingDirectoryCandidate(candidate: string): string {
	const normalized = path.normalize(candidate);
	const marker = normalized.toLowerCase().indexOf('.build\\electron');
	if (marker < 0) {
		return normalized;
	}
	// Source builds start Electron from `<repo>/.build/electron`. Codex should
	// work in the repository, never in the application binary directory. This
	// also repairs the historical malformed `<repo>.build/electron` path.
	return normalized.slice(0, marker).replace(/[\\/]+$/, '');
}

export interface ResolveCliWorkingDirectoryOptions {
	/** The active workspace. When present, falling back elsewhere is unsafe. */
	readonly workspaceDirectory?: string;
	/** Candidate directories used only when no workspace is open. */
	readonly fallbackDirectories: readonly (string | undefined)[];
	readonly homeDirectory: string;
	/** Test seam for checking whether a directory is visible to this extension host. */
	readonly canAccess?: (candidate: string) => Promise<boolean>;
}

/**
 * Resolve the directory in which a provider CLI should run.
 *
 * An active workspace is authoritative. If it is not visible to the current
 * extension host, silently falling back to a local process directory would
 * detach the agent from the user's project (most notably in Remote SSH
 * windows), so fail with an actionable error instead.
 */
export async function resolveCliWorkingDirectory(options: ResolveCliWorkingDirectoryOptions): Promise<string> {
	const canAccess = options.canAccess ?? directoryIsAccessible;
	if (options.workspaceDirectory) {
		const workspaceDirectory = normalizeWorkingDirectoryCandidate(options.workspaceDirectory);
		if (await canAccess(workspaceDirectory)) {
			return workspaceDirectory;
		}
		throw new Error(
			`BatikCode cannot access the active workspace at "${workspaceDirectory}" from the AI provider host. ` +
			'In a Remote SSH window, make sure BatikCode Account & AI Provider Hub is enabled on the remote host.'
		);
	}

	for (const value of options.fallbackDirectories) {
		if (!value) {
			continue;
		}
		const candidate = normalizeWorkingDirectoryCandidate(value);
		if (await canAccess(candidate)) {
			return candidate;
		}
	}

	return options.homeDirectory;
}

async function directoryIsAccessible(candidate: string): Promise<boolean> {
	try {
		await access(candidate);
		return true;
	} catch {
		return false;
	}
}
