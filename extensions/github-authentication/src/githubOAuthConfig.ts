/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The BatikCode-owned GitHub OAuth App (ADR-0001).
 *
 * A client ID is not a secret. It is sent to GitHub from every user's machine
 * on every sign-in, so shipping it in the source is how it is meant to be
 * distributed. There is deliberately no matching client secret: desktop
 * sign-in uses GitHub's device flow, which does not take one, and a secret
 * shipped to a user's machine would not stay secret.
 */
export const BATIKCODE_GITHUB_CLIENT_ID = 'Ov23lihWXPlWrHwiNeK1';

/**
 * Resolves the GitHub OAuth client ID. The environment wins over the user
 * setting, and the BatikCode-owned app is the default, so sign-in works out of
 * the box while a fork or a private build can still point at its own OAuth App
 * without patching this file.
 */
export function resolveGitHubClientId(
	envClientId: string | undefined,
	settingClientId: string
): string {
	return envClientId?.trim() || settingClientId.trim() || BATIKCODE_GITHUB_CLIENT_ID;
}
