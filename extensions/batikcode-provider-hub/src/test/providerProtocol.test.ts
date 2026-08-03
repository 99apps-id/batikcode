/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isVisionModel, openAiChatCompletionsUrl } from '../providerProtocol';

describe('provider protocol helpers', () => {
	it('builds an Azure deployment URL with a default API version', () => {
		assert.equal(
			openAiChatCompletionsUrl('azure', 'https://example.openai.azure.com', 'production/gpt-4o'),
			'https://example.openai.azure.com/openai/deployments/production%2Fgpt-4o/chat/completions?api-version=2024-10-21'
		);
	});

	it('preserves an explicit Azure API version', () => {
		assert.equal(
			openAiChatCompletionsUrl(
				'azure',
				'https://example.openai.azure.com/openai/deployments/prod?api-version=2025-01-01-preview',
				'ignored'
			),
			'https://example.openai.azure.com/openai/deployments/prod/chat/completions?api-version=2025-01-01-preview'
		);
	});

	it('recognizes vision model names without claiming text-only Nemotron is multimodal', () => {
		assert.equal(isVisionModel('meta/llama-3.2-90b-vision-instruct'), true);
		assert.equal(isVisionModel('qwen/qwen2.5-vl-72b'), true);
		assert.equal(isVisionModel('nvidia/nemotron-3-ultra-550b-a55b'), false);
	});

	it('does not treat DeepSeek hosted API models as vision-capable', () => {
		// DeepSeek's api.deepseek.com only serves text models and its
		// OpenAI-compatible endpoint rejects image_url parts with HTTP 400.
		assert.equal(isVisionModel('deepseek-chat'), false);
		assert.equal(isVisionModel('deepseek-reasoner'), false);
		assert.equal(isVisionModel('deepseek-v4-flash'), false);
	});
});
