/*---------------------------------------------------------------------------------------------
 *  Copyright (c) BatikCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

export function openAiChatCompletionsUrl(providerId: string, endpoint: string, model: string): string {
	if (providerId !== 'azure') {
		return `${endpoint}/chat/completions`;
	}
	const url = new URL(endpoint);
	const deploymentSegment = '/openai/deployments/';
	if (!url.pathname.toLowerCase().includes(deploymentSegment)) {
		url.pathname = `${url.pathname.replace(/\/+$/, '')}/openai/deployments/${encodeURIComponent(model)}/chat/completions`;
	} else if (!url.pathname.toLowerCase().endsWith('/chat/completions')) {
		url.pathname = `${url.pathname.replace(/\/+$/, '')}/chat/completions`;
	}
	if (!url.searchParams.has('api-version')) {
		url.searchParams.set('api-version', '2024-10-21');
	}
	return url.toString();
}

export function isVisionModel(model: string): boolean {
	return /vision|vlm|(?:^|[-_/])vl\d*(?:[-_/]|$)|llava|pixtral|gpt-4o|gpt-4\.1|gpt-5|o3|o4-mini|claude|gemini|grok-[2-9]|qwen.*omni|qvq|janus|internvl|minicpm-v/i.test(model);
}

/**
 * Whether images may be sent to this provider/model as OpenAI `image_url` parts.
 *
 * The single source of truth for two decisions that must agree: what the model
 * advertises to the workbench (which gates the attach button) and what the
 * router actually serialises. When they disagree, the workbench accepts an image
 * the endpoint then rejects — and because the image stays in history, every
 * later turn fails too:
 *
 *   HTTP 400: unknown variant `image_url`, expected `text`
 *
 * Providers whose chat API only accepts text parts are excluded outright, no
 * matter what the model is called.
 */
const TEXT_ONLY_CONTENT_PROVIDERS: ReadonlySet<string> = new Set([
	// Rejects image_url with "unknown variant `image_url`, expected `text`".
	'deepseek',
	// OpenAI-compatible search API; content parts are text only.
	'perplexity',
	// Serves open text models; image parts are not part of its schema.
	'cerebras',
	'groq'
]);

export function supportsImageInput(providerId: string, model: string): boolean {
	if (TEXT_ONLY_CONTENT_PROVIDERS.has(providerId)) {
		return false;
	}
	return isVisionModel(model);
}
