/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BATIKCODE_GITHUB_CLIENT_ID, resolveGitHubClientId } from '../githubOAuthConfig';

describe('GitHub OAuth client resolution', () => {
	it('resolves in priority order: environment, setting, then the BatikCode-owned app', () => {
		assert.deepEqual(
			[
				resolveGitHubClientId('env-client', 'setting-client'),
				resolveGitHubClientId(undefined, 'setting-client'),
				resolveGitHubClientId(undefined, ''),
				resolveGitHubClientId('   ', '  setting-client  ')
			],
			[
				'env-client',
				'setting-client',
				BATIKCODE_GITHUB_CLIENT_ID,
				'setting-client'
			]
		);
	});

	it('never resolves to an upstream client the product does not own', () => {
		// Borrowing another product's OAuth app puts their name on the consent
		// screen our users see, so the default has to be ours.
		assert.equal(BATIKCODE_GITHUB_CLIENT_ID, 'Ov23lihWXPlWrHwiNeK1');
	});
});
