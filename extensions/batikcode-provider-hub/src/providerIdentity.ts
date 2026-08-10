/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type ProviderTransport = 'router' | 'codex-cli' | 'gemini-cli' | 'antigravity';

export function providerIdentity(providerName: string, transport: ProviderTransport, modelId: string): string {
	const runtime = transport === 'router'
		? `${providerName} through BatikCode Provider Hub`
		: transport === 'codex-cli'
			? 'the authenticated OpenAI Codex CLI'
		: transport === 'antigravity'
			? 'Antigravity (Google Cloud Code)'
			: 'Google Gemini CLI Cloud Code OAuth';
	return `You are an AI assistant in BatikCode using ${runtime} with model "${modelId}". `
		+ 'When asked about your identity, state this provider, model, and transport accurately. '
		+ 'Do not claim to use GitHub Copilot or Copilot CLI unless the active transport is actually GitHub Copilot CLI.';
}
