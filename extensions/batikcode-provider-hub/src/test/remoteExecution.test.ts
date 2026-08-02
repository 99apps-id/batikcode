/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { resolveCliWorkingDirectory } from '../cliProcess';

describe('remote provider execution', () => {
	it('prefers the remote-capable workspace extension host', () => {
		const manifestPath = path.resolve(__dirname, '..', '..', 'package.json');
		const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { extensionKind?: readonly string[] };

		assert.deepEqual(manifest.extensionKind, ['workspace', 'ui']);
	});

	it('uses the active workspace when it is accessible', async () => {
		const checked: string[] = [];
		const result = await resolveCliWorkingDirectory({
			workspaceDirectory: '/srv/project',
			fallbackDirectories: ['/local/fallback'],
			homeDirectory: '/home/user',
			canAccess: async candidate => {
				checked.push(candidate);
				return candidate === path.normalize('/srv/project');
			}
		});

		assert.equal(result, path.normalize('/srv/project'));
		assert.deepEqual(checked, [path.normalize('/srv/project')]);
	});

	it('does not silently fall back locally when the active workspace is inaccessible', async () => {
		const checked: string[] = [];
		await assert.rejects(
			resolveCliWorkingDirectory({
				workspaceDirectory: '/srv/project',
				fallbackDirectories: ['C:\\local\\fallback'],
				homeDirectory: 'C:\\Users\\test',
				canAccess: async candidate => {
					checked.push(candidate);
					return false;
				}
			}),
			/AI provider host/
		);
		assert.deepEqual(checked, [path.normalize('/srv/project')]);
	});

	it('uses local fallbacks only when no workspace is open', async () => {
		const result = await resolveCliWorkingDirectory({
			fallbackDirectories: ['/missing', '/available'],
			homeDirectory: '/home/user',
			canAccess: async candidate => candidate === path.normalize('/available')
		});

		assert.equal(result, path.normalize('/available'));
	});
});
