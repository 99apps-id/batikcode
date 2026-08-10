/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { OAuthBootstrapId } from './oauthCliBootstrap';

export type ProviderKind = 'account' | 'subscription' | 'apiKey' | 'local';
export type ProviderProtocol = 'openai' | 'anthropic' | 'gemini' | 'ollama';
export type ProviderAuthentication = 'bearer' | 'x-api-key' | 'x-goog-api-key' | 'api-key' | 'custom' | 'none';

export interface ProviderRoutingDefinition {
	readonly protocol: ProviderProtocol;
	readonly defaultEndpoint?: string;
	readonly defaultModel?: string;
	readonly authentication: ProviderAuthentication;
	readonly requiresKey: boolean;
}

export interface ProviderDefinition {
	readonly id: string;
	readonly vendor?: string;
	readonly name: string;
	readonly shortName: string;
	readonly description: string;
	readonly kind: ProviderKind;
	readonly action: 'github' | 'copilot' | 'oauthBootstrap' | 'configure';
	readonly oauthBootstrapId?: OAuthBootstrapId;
	readonly accent: string;
	readonly routing?: ProviderRoutingDefinition;
}

/**
 * Every visible provider is backed by either a native authentication adapter
 * or ProviderRouter. Adding a card without an executable path would create a
 * false-success state.
 */
export const PROVIDERS: readonly ProviderDefinition[] = [
	{
		id: 'github',
		name: 'GitHub',
		shortName: 'GH',
		description: 'Repositories, publishing, pull requests, and Git credentials.',
		kind: 'account',
		action: 'github',
		accent: '#a9b1d6'
	},
	{
		id: 'copilot',
		vendor: 'copilot',
		name: 'GitHub Copilot',
		shortName: 'CP',
		description: 'Copilot chat, agent mode, completions, and subscription models.',
		kind: 'subscription',
		action: 'copilot',
		accent: '#67d4b5'
	},
	{
		id: 'codex',
		vendor: 'openai',
		name: 'OpenAI Codex',
		shortName: 'CX',
		description: 'Use the official Codex CLI browser sign-in without registering a separate OAuth application.',
		kind: 'subscription',
		action: 'oauthBootstrap',
		oauthBootstrapId: 'codex-cli',
		accent: '#8dd3bb'
	},
	{
		id: 'gemini-cli',
		vendor: 'gemini',
		name: 'Gemini CLI OAuth',
		shortName: 'GC',
		description: 'Sign in with Google and use Gemini Code Assist through the Cloud Code OAuth preset.',
		kind: 'subscription',
		action: 'oauthBootstrap',
		oauthBootstrapId: 'gemini-cli',
		accent: '#7aa7ff'
	},
	{
		id: 'antigravity',
		vendor: 'gemini',
		name: 'Antigravity (Google)',
		shortName: 'AG',
		description: 'Sign in with a Google account to reach Cloud Code models, including Gemini 3 and Claude through Antigravity.',
		kind: 'subscription',
		action: 'oauthBootstrap',
		oauthBootstrapId: 'antigravity',
		accent: '#9b87f5'
	},
	{
		id: 'kiro',
		vendor: 'kiro',
		name: 'AWS Kiro',
		shortName: 'KR',
		description: 'Open the installed Kiro client and use its AWS Builder ID or organization sign-in.',
		kind: 'subscription',
		action: 'oauthBootstrap',
		oauthBootstrapId: 'kiro-client',
		accent: '#c994ff'
	},
	{
		id: 'openai',
		vendor: 'openai',
		name: 'OpenAI',
		shortName: 'OA',
		description: 'Route chat requests using one or more OpenAI API keys.',
		kind: 'apiKey',
		action: 'configure',
		accent: '#8dd3bb',
		routing: {
			protocol: 'openai',
			defaultEndpoint: 'https://api.openai.com/v1',
			defaultModel: 'gpt-4o',
			authentication: 'bearer',
			requiresKey: true
		}
	},
	{
		id: 'anthropic',
		vendor: 'anthropic',
		name: 'Anthropic',
		shortName: 'AN',
		description: 'Connect Claude models using an Anthropic API key.',
		kind: 'apiKey',
		action: 'configure',
		accent: '#d9a77c',
		routing: {
			protocol: 'anthropic',
			defaultEndpoint: 'https://api.anthropic.com/v1',
			defaultModel: 'claude-sonnet-4-20250514',
			authentication: 'x-api-key',
			requiresKey: true
		}
	},
	{
		id: 'gemini',
		vendor: 'gemini',
		name: 'Google Gemini',
		shortName: 'GM',
		description: 'Connect Gemini models using a Google AI API key.',
		kind: 'apiKey',
		action: 'configure',
		accent: '#7aa7ff',
		routing: {
			protocol: 'gemini',
			defaultEndpoint: 'https://generativelanguage.googleapis.com/v1beta',
			defaultModel: 'gemini-2.5-flash',
			authentication: 'x-goog-api-key',
			requiresKey: true
		}
	},
	{
		id: 'openrouter',
		vendor: 'openrouter',
		name: 'OpenRouter',
		shortName: 'OR',
		description: 'Use one key to access models routed through OpenRouter.',
		kind: 'apiKey',
		action: 'configure',
		accent: '#b89cff',
		routing: {
			protocol: 'openai',
			defaultEndpoint: 'https://openrouter.ai/api/v1',
			defaultModel: 'openai/gpt-4o',
			authentication: 'bearer',
			requiresKey: true
		}
	},
	{
		id: 'xai',
		vendor: 'xai',
		name: 'xAI',
		shortName: 'xAI',
		description: 'Connect Grok models using an xAI API key.',
		kind: 'apiKey',
		action: 'configure',
		accent: '#c5c9d3',
		routing: {
			protocol: 'openai',
			defaultEndpoint: 'https://api.x.ai/v1',
			defaultModel: 'grok-3-fast',
			authentication: 'bearer',
			requiresKey: true
		}
	},
	{
		id: 'azure',
		vendor: 'azure',
		name: 'Azure OpenAI',
		shortName: 'AZ',
		description: 'Configure Azure endpoint, deployment, and credentials.',
		kind: 'apiKey',
		action: 'configure',
		accent: '#55b5e8',
		routing: {
			protocol: 'openai',
			authentication: 'api-key',
			requiresKey: true
		}
	},
	{
		id: 'ollama',
		vendor: 'ollama',
		name: 'Ollama',
		shortName: 'OL',
		description: 'Use local models without sending an API key to BatikCode.',
		kind: 'local',
		action: 'configure',
		accent: '#e5e7eb',
		routing: {
			protocol: 'ollama',
			defaultEndpoint: 'http://127.0.0.1:11434/api',
			defaultModel: 'qwen2.5-coder',
			authentication: 'none',
			requiresKey: false
		}
	},
	{
		id: 'deepseek',
		name: 'DeepSeek',
		shortName: 'DS',
		description: 'Use DeepSeek chat and reasoning models through its OpenAI-compatible API.',
		kind: 'apiKey',
		action: 'configure',
		accent: '#5f8dff',
		routing: {
			protocol: 'openai',
			defaultEndpoint: 'https://api.deepseek.com',
			defaultModel: 'deepseek-chat',
			authentication: 'bearer',
			requiresKey: true
		}
	},
	{
		id: 'groq',
		name: 'Groq',
		shortName: 'GQ',
		description: 'Route supported open models through GroqCloud inference.',
		kind: 'apiKey',
		action: 'configure',
		accent: '#f27b52',
		routing: {
			protocol: 'openai',
			defaultEndpoint: 'https://api.groq.com/openai/v1',
			defaultModel: 'llama-3.3-70b-versatile',
			authentication: 'bearer',
			requiresKey: true
		}
	},
	{
		id: 'mistral',
		name: 'Mistral AI',
		shortName: 'MI',
		description: 'Connect Mistral and Codestral models using an API key.',
		kind: 'apiKey',
		action: 'configure',
		accent: '#f5a524',
		routing: {
			protocol: 'openai',
			defaultEndpoint: 'https://api.mistral.ai/v1',
			defaultModel: 'mistral-medium-latest',
			authentication: 'bearer',
			requiresKey: true
		}
	},
	{
		id: 'together',
		name: 'Together AI',
		shortName: 'TG',
		description: 'Use hosted open models through Together AI.',
		kind: 'apiKey',
		action: 'configure',
		accent: '#9b87f5',
		routing: {
			protocol: 'openai',
			defaultEndpoint: 'https://api.together.xyz/v1',
			defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
			authentication: 'bearer',
			requiresKey: true
		}
	},
	{
		id: 'qwen',
		name: 'Alibaba DashScope (Qwen)',
		shortName: 'QW',
		description: 'Pay-as-you-go Qwen models through the international DashScope endpoint.',
		kind: 'apiKey',
		action: 'configure',
		accent: '#6d8cff',
		routing: {
			protocol: 'openai',
			defaultEndpoint: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
			defaultModel: 'qwen-plus',
			authentication: 'bearer',
			requiresKey: true
		}
	},
	{
		// Separate from the pay-as-you-go entry rather than a swapped endpoint:
		// the two plans are billed differently and issue their own keys, so a
		// single card would force one to be reconfigured to reach the other.
		id: 'qwen-subscription',
		name: 'Alibaba Qwen (Subscription)',
		shortName: 'QWS',
		description: 'Qwen models on a prepaid token plan, billed against the subscription rather than per request.',
		kind: 'apiKey',
		action: 'configure',
		accent: '#6d8cff',
		routing: {
			protocol: 'openai',
			defaultEndpoint: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
			defaultModel: 'qwen-plus',
			authentication: 'bearer',
			requiresKey: true
		}
	},
	{
		id: 'fireworks',
		name: 'Fireworks AI',
		shortName: 'FW',
		description: 'Use serverless Fireworks models through its inference API.',
		kind: 'apiKey',
		action: 'configure',
		accent: '#ff735c',
		routing: {
			protocol: 'openai',
			defaultEndpoint: 'https://api.fireworks.ai/inference/v1',
			defaultModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
			authentication: 'bearer',
			requiresKey: true
		}
	},
	{
		id: 'cerebras',
		name: 'Cerebras',
		shortName: 'CB',
		description: 'Use Cerebras inference through its OpenAI-compatible endpoint.',
		kind: 'apiKey',
		action: 'configure',
		accent: '#f2c14e',
		routing: {
			protocol: 'openai',
			defaultEndpoint: 'https://api.cerebras.ai/v1',
			defaultModel: 'llama-3.3-70b',
			authentication: 'bearer',
			requiresKey: true
		}
	},
	{
		id: 'nvidia',
		name: 'NVIDIA NIM',
		shortName: 'NV',
		description: 'Connect NVIDIA-hosted NIM models with an API key.',
		kind: 'apiKey',
		action: 'configure',
		accent: '#76b900',
		routing: {
			protocol: 'openai',
			defaultEndpoint: 'https://integrate.api.nvidia.com/v1',
			defaultModel: 'nvidia/llama-3.1-nemotron-70b-instruct',
			authentication: 'bearer',
			requiresKey: true
		}
	},
	{
		id: 'githubmodels',
		name: 'GitHub Models',
		shortName: 'GM',
		description: 'Use GitHub Models with a token that has models:read permission.',
		kind: 'apiKey',
		action: 'configure',
		accent: '#b6c2cf',
		routing: {
			protocol: 'openai',
			defaultEndpoint: 'https://models.github.ai/inference',
			defaultModel: 'openai/gpt-4.1',
			authentication: 'bearer',
			requiresKey: true
		}
	},
	{
		id: 'moonshot',
		name: 'Moonshot (Kimi)',
		shortName: 'KM',
		description: 'Connect Kimi models through Moonshot’s OpenAI-compatible API.',
		kind: 'apiKey',
		action: 'configure',
		accent: '#8d95ff',
		routing: {
			protocol: 'openai',
			defaultEndpoint: 'https://api.moonshot.cn/v1',
			defaultModel: 'moonshot-v1-auto',
			authentication: 'bearer',
			requiresKey: true
		}
	},
	{
		id: 'zhipu-glm',
		name: 'Zhipu GLM',
		shortName: 'GLM',
		description: 'Use GLM coding and chat models through the BigModel API.',
		kind: 'apiKey',
		action: 'configure',
		accent: '#4ecdc4',
		routing: {
			protocol: 'openai',
			defaultEndpoint: 'https://open.bigmodel.cn/api/paas/v4',
			defaultModel: 'glm-4.5-air',
			authentication: 'bearer',
			requiresKey: true
		}
	},
	{
		id: 'minimax',
		name: 'MiniMax',
		shortName: 'MM',
		description: 'Route requests to MiniMax through its OpenAI-compatible endpoint.',
		kind: 'apiKey',
		action: 'configure',
		accent: '#ff8c69',
		routing: {
			protocol: 'openai',
			defaultEndpoint: 'https://api.minimax.io/v1',
			defaultModel: 'MiniMax-M2.5',
			authentication: 'bearer',
			requiresKey: true
		}
	},
	{
		id: 'siliconflow',
		name: 'SiliconFlow',
		shortName: 'SF',
		description: 'Use hosted open models through SiliconFlow’s compatible API.',
		kind: 'apiKey',
		action: 'configure',
		accent: '#55d6a4',
		routing: {
			protocol: 'openai',
			defaultEndpoint: 'https://api.siliconflow.com/v1',
			defaultModel: 'deepseek-ai/DeepSeek-V3.2',
			authentication: 'bearer',
			requiresKey: true
		}
	},
	{
		id: 'perplexity',
		name: 'Perplexity',
		shortName: 'PX',
		description: 'Use Sonar search models through Perplexity’s compatible chat API.',
		kind: 'apiKey',
		action: 'configure',
		accent: '#20b8a6',
		routing: {
			protocol: 'openai',
			defaultEndpoint: 'https://api.perplexity.ai',
			defaultModel: 'sonar',
			authentication: 'bearer',
			requiresKey: true
		}
	},
	{
		id: 'deepinfra',
		name: 'DeepInfra',
		shortName: 'DI',
		description: 'Route open models through DeepInfra’s OpenAI-compatible API.',
		kind: 'apiKey',
		action: 'configure',
		accent: '#73a6ff',
		routing: {
			protocol: 'openai',
			defaultEndpoint: 'https://api.deepinfra.com/v1/openai',
			defaultModel: 'meta-llama/Meta-Llama-3.1-8B-Instruct',
			authentication: 'bearer',
			requiresKey: true
		}
	},
	{
		id: 'sambanova',
		name: 'SambaNova',
		shortName: 'SN',
		description: 'Use SambaNova Cloud models with key rotation and fallback.',
		kind: 'apiKey',
		action: 'configure',
		accent: '#f4c542',
		routing: {
			protocol: 'openai',
			defaultEndpoint: 'https://api.sambanova.ai/v1',
			defaultModel: 'Meta-Llama-3.3-70B-Instruct',
			authentication: 'bearer',
			requiresKey: true
		}
	},
	{
		id: 'customendpoint',
		vendor: 'customendpoint',
		name: 'Custom endpoint',
		shortName: 'CE',
		description: 'Connect an OpenAI Chat Completions-compatible endpoint with a configurable auth header.',
		kind: 'apiKey',
		action: 'configure',
		accent: '#f0b35a',
		routing: {
			protocol: 'openai',
			authentication: 'custom',
			requiresKey: true
		}
	}
] as const;

/**
 * The vendor id a provider's chat models are registered under. Prefixed because
 * the bundled Copilot extension already claims the bare names (`openai`,
 * `anthropic`, `gemini`, ...) for its own BYOK vendors.
 */
export function providerVendorId(providerId: string): string {
	return `batikcode-${providerId}`;
}

/**
 * Providers that can serve chat models: everything routable, plus the two CLI
 * transports. Each is registered as its own vendor so the model picker groups a
 * model under the provider that actually serves it rather than under a single
 * hub-wide bucket.
 */
export const MODEL_PROVIDERS: readonly ProviderDefinition[] = PROVIDERS.filter(
	provider => !!provider.routing
		|| provider.oauthBootstrapId === 'codex-cli'
		|| provider.oauthBootstrapId === 'gemini-cli'
		|| provider.oauthBootstrapId === 'antigravity'
);
