/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	cooldownDuration,
	describeRawBody,
	extractModelIds,
	extractText,
	extractToolCalls,
	isRetryableStatus,
	parseRetryAfter,
	ProviderConfiguration,
	resolveFallbackChain,
	responseError,
	toOpenAiMessage
} from '../providerRouterUtils';

describe('provider router retry classification', () => {
	it('treats auth, throttling, and server errors as retryable', () => {
		for (const status of [401, 403, 408, 409, 425, 429, 500, 502, 503]) {
			assert.equal(isRetryableStatus(status), true, `HTTP ${status} should be retryable`);
		}
	});

	it('does not retry client errors or success', () => {
		for (const status of [200, 201, 400, 404, 422, 451]) {
			assert.equal(isRetryableStatus(status), false, `HTTP ${status} should not be retryable`);
		}
	});
});

describe('provider router fallback chain', () => {
	it('returns only the requested provider when no fallbacks exist', () => {
		assert.deepEqual(resolveFallbackChain({}, 'deepseek'), ['deepseek']);
	});

	it('visits configured fallbacks in declared order', () => {
		const configurations: Record<string, ProviderConfiguration> = {
			deepseek: { fallbackProviderIds: ['openrouter', 'groq'] },
			openrouter: { fallbackProviderIds: ['groq'] },
			groq: {}
		};
		assert.deepEqual(resolveFallbackChain(configurations, 'deepseek'), ['deepseek', 'openrouter', 'groq']);
	});

	it('ignores fallback cycles without revisiting a provider', () => {
		const configurations: Record<string, ProviderConfiguration> = {
			deepseek: { fallbackProviderIds: ['openrouter'] },
			openrouter: { fallbackProviderIds: ['deepseek'] }
		};
		assert.deepEqual(resolveFallbackChain(configurations, 'deepseek'), ['deepseek', 'openrouter']);
	});
});

describe('provider router cooldowns', () => {
	it('keeps authentication failures on cooldown longer than throttling', () => {
		assert.ok(cooldownDuration(401) > cooldownDuration(429));
		assert.ok(cooldownDuration(403) > cooldownDuration(429));
	});

	it('bounds throttling and transient cooldowns', () => {
		assert.ok(cooldownDuration(429) > cooldownDuration(500));
		assert.ok(cooldownDuration(500) > 0);
	});

	it('honors a Retry-After header but caps it at the throttle cooldown', () => {
		const capped = parseRetryAfter(new Headers({ 'retry-after': '999999' }));
		assert.equal(capped, 60_000);
		const short = parseRetryAfter(new Headers({ 'retry-after': '7' }));
		assert.equal(short, 7_000);
		assert.equal(parseRetryAfter(new Headers({})), undefined);
	});
});

describe('provider router response extraction', () => {
	it('extracts OpenAI text from choices', () => {
		assert.equal(extractText('openai', { choices: [{ message: { content: 'hello' } }] }), 'hello');
		assert.equal(extractText('openai', { choices: [{ text: 'legacy' }] }), 'legacy');
	});

	it('extracts Anthropic text blocks', () => {
		assert.equal(extractText('anthropic', { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'ab');
	});

	it('extracts Gemini candidate parts', () => {
		assert.equal(extractText('gemini', { candidates: [{ content: { parts: [{ text: 'gem' }] } }] }), 'gem');
	});

	it('extracts Ollama message content', () => {
		assert.equal(extractText('ollama', { message: { content: 'ollama' } }), 'ollama');
	});
});

describe('provider router tool call extraction', () => {
	it('extracts OpenAI function calls', () => {
		const calls = extractToolCalls('openai', {
			choices: [{
				message: {
					tool_calls: [{
						id: 'call_1',
						type: 'function',
						function: { name: 'read_file', arguments: '{"path":"a.ts"}' }
					}]
				}
			}]
		});
		assert.deepEqual(calls, [{ id: 'call_1', name: 'read_file', arguments: { path: 'a.ts' } }]);
	});

	it('extracts Anthropic tool_use blocks', () => {
		const calls = extractToolCalls('anthropic', {
			content: [{ type: 'tool_use', id: 'toolu_1', name: 'search', input: { query: 'x' } }]
		});
		assert.deepEqual(calls, [{ id: 'toolu_1', name: 'search', arguments: { query: 'x' } }]);
	});

	it('extracts Gemini function calls', () => {
		const calls = extractToolCalls('gemini', {
			candidates: [{ content: { parts: [{ functionCall: { name: 'list', args: { limit: 2 } } }] } }]
		});
		assert.deepEqual(calls, [{ id: 'list', name: 'list', arguments: { limit: 2 } }]);
	});

	it('returns no calls when identifiers are missing', () => {
		assert.deepEqual(extractToolCalls('openai', { choices: [{ message: {} }] }), []);
		assert.deepEqual(extractToolCalls('anthropic', { content: [{ type: 'text', text: 'x' }] }), []);
	});
});

describe('provider router model discovery', () => {
	it('extracts and deduplicates OpenAI model IDs', () => {
		const models = extractModelIds('openai', { data: [{ id: 'gpt-4o' }, { id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] });
		assert.deepEqual(models, ['gpt-4o', 'gpt-4o-mini']);
	});

	it('strips Gemini models/ prefix', () => {
		const models = extractModelIds('gemini', { models: [{ name: 'models/gemini-2.5-flash' }] });
		assert.deepEqual(models, ['gemini-2.5-flash']);
	});

	it('strips a vendor prefix only when the default model is not vendor-prefixed', () => {
		assert.deepEqual(extractModelIds('openai', { data: [{ id: 'deepseek-ai/DeepSeek-V3.2' }] }), ['DeepSeek-V3.2']);
		assert.deepEqual(extractModelIds('openai', { data: [{ id: 'deepseek-ai/DeepSeek-V3.2' }] }, 'deepseek-ai/DeepSeek-V3.2'), ['deepseek-ai/DeepSeek-V3.2']);
	});
});

describe('provider router error normalization', () => {
	it('includes status and a truncated provider message', () => {
		const message = 'x'.repeat(500);
		const error = responseError(502, { error: { message } });
		assert.ok(error.includes('HTTP 502'));
		assert.ok(error.length < 400);
	});

	it('maps 401 and 404 to actionable BatikCode messages', () => {
		assert.equal(responseError(401, {}, undefined, 'deepseek'), 'Authentication failed for deepseek. Please check your API key and try again.');
		assert.equal(responseError(404, {}, undefined, 'deepseek'), 'Endpoint not found for deepseek. Please check your endpoint configuration.');
		assert.equal(responseError(500, {}, undefined, 'deepseek'), 'Internal server error for deepseek. Please try again later.');
	});

	it('adds retry guidance for rate limits', () => {
		const error = responseError(429, {}, new Headers({ 'retry-after': '30' }));
		assert.ok(error.includes('Rate limit exceeded'));
		assert.ok(error.includes('Retry after 30s'));
	});
});

describe('provider router body diagnostics and message mapping', () => {
	it('describes empty and non-JSON bodies without leaking content', () => {
		assert.equal(describeRawBody(undefined), 'empty body');
		assert.equal(describeRawBody(''), 'empty body');
		assert.ok(describeRawBody('not json').includes('non-JSON text'));
		assert.equal(describeRawBody({ ok: true }), '');
	});

	it('downgrades image parts to text for non-vision models', () => {
		const message = {
			role: 'user' as const,
			content: [{ type: 'image' as const, mimeType: 'image/png', data: 'aGVsbG8=' }]
		};
		const downgraded = toOpenAiMessage(message, false) as { content: readonly { type: string; text: string }[] };
		assert.equal(downgraded.content[0].type, 'text');
		assert.ok(downgraded.content[0].text.includes('[Image attached'));
	});

	it('keeps image data URLs for vision-capable models', () => {
		const message = {
			role: 'user' as const,
			content: [{ type: 'image' as const, mimeType: 'image/png', data: 'aGVsbG8=' }]
		};
		const mapped = toOpenAiMessage(message, true) as { content: readonly { type: string; image_url: { url: string } }[] };
		assert.equal(mapped.content[0].type, 'image_url');
		assert.ok(mapped.content[0].image_url.url.startsWith('data:image/png;base64,'));
	});

	it('serializes tool results with their call id', () => {
		const mapped = toOpenAiMessage(
			{ role: 'tool', content: 'done', toolCallId: 'call_9' },
			true
		) as { role: string; tool_call_id: string; content: string };
		assert.equal(mapped.role, 'tool');
		assert.equal(mapped.tool_call_id, 'call_9');
		assert.equal(mapped.content, 'done');
	});
});
