/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { materializeImagesForCli } from './cliImages';
import { CloudCodeTurn, OAuthBootstrapId, OAuthCliBootstrap } from './oauthCliBootstrap';
import { ProviderDefinition } from './providerCatalog';
import { providerIdentity, ProviderTransport } from './providerIdentity';
import { ProviderModelCatalog } from './providerModelCatalog';
import { supportsImageInput } from './providerProtocol';
import { NormalizedChatMessage, NormalizedContentPart, NormalizedTool, ProviderRouter } from './providerRouter';

interface BatikCodeModel extends vscode.LanguageModelChatInformation {
	readonly providerId: string;
	readonly providerName: string;
	readonly transport: ProviderTransport;
}

/**
 * Serves the models of a single upstream provider. One instance is registered
 * per provider vendor so the model picker attributes each model to the provider
 * that actually serves it.
 */
export class BatikCodeLanguageModelProvider implements vscode.LanguageModelChatProvider<BatikCodeModel> {
	/** Shared across providers: one channel for "why is my model missing". */
	private static readonly log = vscode.window.createOutputChannel('BatikCode Models', { log: true });

	private readonly changeEmitter = new vscode.EventEmitter<void>();
	public readonly onDidChangeLanguageModelChatInformation = this.changeEmitter.event;
	private readonly disposables: vscode.Disposable[] = [];

	public constructor(
		private readonly provider: ProviderDefinition,
		private readonly router: ProviderRouter,
		private readonly oauth: OAuthCliBootstrap,
		private readonly modelCatalog: ProviderModelCatalog
	) {
		this.disposables.push(
			this.router.onDidChange(() => this.changeEmitter.fire()),
			this.oauth.onDidChange(() => this.changeEmitter.fire()),
			this.modelCatalog.onDidChange(() => this.changeEmitter.fire())
		);
	}

	public dispose(): void {
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.disposables.length = 0;
		this.changeEmitter.dispose();
	}

	public async provideLanguageModelChatInformation(): Promise<BatikCodeModel[]> {
		try {
			return await this.collectModels();
		} catch (error) {
			// A rejection here makes the workbench drop this vendor's models with
			// no trace anywhere — the provider simply appears to have none. Name
			// the failure, then let it propagate so the caller still sees it.
			BatikCodeLanguageModelProvider.log.appendLine(
				`[models] ${this.provider.name}: failed to list models — ${error instanceof Error ? error.stack ?? error.message : String(error)}`
			);
			throw error;
		}
	}

	private async collectModels(): Promise<BatikCodeModel[]> {
		const result: BatikCodeModel[] = [];
		if (this.provider.routing) {
			const status = await this.router.getStatus(this.provider.id);
			if (status.configured) {
				for (const model of status.models) {
					result.push(modelInformation(this.provider, model, 'router'));
				}
			} else {
				BatikCodeLanguageModelProvider.log.appendLine(
					`[models] ${this.provider.name}: not configured (endpoint/model/enabled account missing) — no models offered.`
				);
			}
		} else if (
			this.provider.oauthBootstrapId === 'codex-cli'
			|| this.provider.oauthBootstrapId === 'gemini-cli'
			|| this.provider.oauthBootstrapId === 'antigravity'
		) {
			await this.appendCliModels(result, this.provider.oauthBootstrapId);
		}
		return result;
	}

	public async provideLanguageModelChatResponse(
		model: BatikCodeModel,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken
	): Promise<void> {
		const normalized = normalizeMessages(messages);
		if (!normalized.length) {
			throw new Error('The BatikCode model request did not contain any supported text.');
		}
		const selectedModelId = model.id.slice(model.providerId.length + 1);
		const messagesWithIdentity: NormalizedChatMessage[] = [
			{ role: 'system', content: providerIdentity(model.providerName, model.transport, selectedModelId) },
			...normalized
		];
		let text: string;
		let emittedToolCalls = 0;
		let streamedText = false;
		let attempts: readonly { providerId: string; reason: string }[] | undefined;
		if (model.transport === 'router') {
			const response = await this.router.routeChat({
				providerId: model.providerId,
				model: selectedModelId,
				messages: messagesWithIdentity,
				tools: options.tools?.map(tool => ({
					name: tool.name,
					description: tool.description,
					inputSchema: tool.inputSchema ?? { type: 'object', properties: {} }
				})),
				toolMode: options.toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto',
				onText: chunk => {
					streamedText = true;
					progress.report(new vscode.LanguageModelTextPart(chunk));
				},
				signal: cancellationSignal(token)
			});
			text = response.text;
			attempts = response.attempts;
			for (const call of response.toolCalls) {
				progress.report(new vscode.LanguageModelToolCallPart(call.id, call.name, call.arguments));
				emittedToolCalls++;
			}
		} else if (model.transport === 'antigravity' || model.transport === 'gemini-cli') {
			// Cloud Code speaks Gemini over HTTP, so unlike the CLI transports it
			// can declare tools and return functionCall parts — which is what makes
			// these models usable in agent mode.
			const reply = await this.oauth.runCloudCodeChat(
				model.transport,
				selectedModelId,
				toCloudCodeContents(normalized),
				providerIdentity(model.providerName, model.transport, selectedModelId),
				options.tools?.map(tool => ({
					name: tool.name,
					description: tool.description,
					inputSchema: tool.inputSchema ?? { type: 'object', properties: {} }
				})),
				options.toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto',
				token
			);
			text = reply.text;
			for (const call of reply.toolCalls) {
				progress.report(new vscode.LanguageModelToolCallPart(call.id, call.name, call.arguments));
				emittedToolCalls++;
			}
		} else {
			const materialized = await materializeImagesForCli(messagesWithIdentity);
			try {
				const cliPrompt = asCliPrompt(
					materialized.messages,
					options.tools?.map(tool => ({
						name: tool.name,
						description: tool.description,
						inputSchema: tool.inputSchema ?? { type: 'object', properties: {} }
					}))
				);
				text = await this.oauth.runChat(
					model.transport,
					selectedModelId,
					cliPrompt,
					token
				);
			} finally {
				await materialized.dispose();
			}
		}
		if (!text && emittedToolCalls > 0) {
			return;
		}
		if (!text) {
			const detail = formatFailureDetail(model, attempts);
			throw new Error(`${model.name} (${model.providerName}) returned an empty response.${detail}`);
		}
		if (!streamedText) {
			progress.report(new vscode.LanguageModelTextPart(text));
		}
	}

	public async provideTokenCount(
		_model: BatikCodeModel,
		text: string | vscode.LanguageModelChatRequestMessage
	): Promise<number> {
		const value = typeof text === 'string' ? text : messageText(text);
		return Math.max(1, Math.ceil(value.length / 4));
	}

	private async appendCliModels(result: BatikCodeModel[], bootstrapId: Extract<OAuthBootstrapId, ProviderTransport>): Promise<void> {
		const provider = this.provider;
		const status = await this.oauth.getStatus(bootstrapId);
		if (!status.connected) {
			BatikCodeLanguageModelProvider.log.appendLine(
				`[models] ${provider.name}: not connected (${status.label}) — no models offered.`
			);
			return;
		}
		const discovered = await this.oauth.getChatModels(bootstrapId);
		BatikCodeLanguageModelProvider.log.appendLine(
			`[models] ${provider.name}: connected, ${discovered.length} model(s) discovered.`
		);
		// Build lookup by both raw ID and cleaned ID (without vendor prefix).
		const discoveredById = new Map<string, { id: string; name: string }>();
		for (const model of discovered) {
			discoveredById.set(model.id, model);
			discoveredById.set(stripVendorPrefix(model.id), model);
		}
		const configured = this.modelCatalog.getModels(provider.id, discovered.map(model => model.id));
		for (const modelId of configured) {
			const displayName = discoveredById.get(modelId)?.name ?? discoveredById.get(stripVendorPrefix(modelId))?.name ?? modelId;
			result.push(modelInformation(provider, modelId, bootstrapId, displayName));
		}
	}
}

function modelInformation(
	provider: ProviderDefinition,
	model: string,
	transport: BatikCodeModel['transport'],
	name?: string
): BatikCodeModel {
	// When the provider's default model doesn't use vendor-prefixed names
	// (e.g. "deepseek-chat" vs "deepseek-ai/DeepSeek-V3.2"), strip any
	// vendor prefix from discovered model IDs for clean display.
	const usesVendorPrefixInDefault = provider.routing?.defaultModel?.includes('/') ?? false;
	// When the provider uses vendor-prefixed model IDs (e.g. OpenRouter: "deepseek-ai/deepseek-v4-flash"),
	// strip the vendor prefix for clean display in the model picker.
	// The full ID is preserved in `model.id` for API requests.
	const displayModel = name ?? (usesVendorPrefixInDefault ? stripVendorPrefix(model) : model);
	return {
		id: `${provider.id}:${model}`,
		name: displayModel,
		family: model,
		version: '1',
		tooltip: `${provider.name} through ${transport === 'router' ? 'BatikCode secure key routing' : transport === 'codex-cli' ? 'the official authenticated CLI' : 'Cloud Code OAuth'}`,
		detail: provider.name,
		maxInputTokens: 128_000,
		maxOutputTokens: 16_384,
		capabilities: modelCapabilities(provider, model, transport),
		providerId: provider.id,
		providerName: provider.name,
		transport
	};
}

/** Strip the vendor prefix from a model ID (e.g. "deepseek-ai/DeepSeek-V3.2" → "DeepSeek-V3.2"). */
function stripVendorPrefix(model: string): string {
	const slashIndex = model.indexOf('/');
	if (slashIndex > 0 && slashIndex < model.length - 1) {
		return model.slice(slashIndex + 1);
	}
	return model;
}

function normalizeMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): NormalizedChatMessage[] {
	return messages.flatMap(message => {
		const role = message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' as const : 'user' as const;
		const content: NormalizedContentPart[] = [];
		const toolCalls: { id: string; name: string; arguments: object }[] = [];
		const toolResults: NormalizedChatMessage[] = [];
		for (const part of message.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				if (part.value) {
					content.push({ type: 'text', text: part.value });
				}
			} else if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith('image/')) {
				content.push({
					type: 'image',
					mimeType: part.mimeType,
					data: Buffer.from(part.data).toString('base64')
				});
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				toolCalls.push({ id: part.callId, name: part.name, arguments: part.input });
			} else if (part instanceof vscode.LanguageModelToolResultPart) {
				toolResults.push({
					role: 'tool',
					toolCallId: part.callId,
					content: toolResultText(part)
				});
			}
		}
		const result: NormalizedChatMessage[] = [];
		if (content.length || toolCalls.length) {
			result.push({
				role,
				content,
				...(toolCalls.length ? { toolCalls } : {})
			});
		}
		result.push(...toolResults);
		return result;
	});
}

function messageText(message: vscode.LanguageModelChatRequestMessage): string {
	return message.content
		.map(part => part instanceof vscode.LanguageModelTextPart ? part.value : '')
		.filter(Boolean)
		.join('\n');
}

function toolResultText(result: vscode.LanguageModelToolResultPart): string {
	return result.content.map(part => {
		if (part instanceof vscode.LanguageModelTextPart) {
			return part.value;
		}
		if (part instanceof vscode.LanguageModelDataPart) {
			return part.mimeType.startsWith('text/')
				? new TextDecoder().decode(part.data)
				: `[${part.mimeType} tool result]`;
		}
		try {
			return JSON.stringify(part);
		} catch {
			return String(part);
		}
	}).filter(Boolean).join('\n');
}

function modelCapabilities(
	provider: ProviderDefinition,
	model: string,
	transport: BatikCodeModel['transport']
): vscode.LanguageModelChatCapabilities {
	if (transport === 'antigravity' || transport === 'gemini-cli') {
		// Cloud Code is reached over HTTP with Gemini's function-calling API, so
		// this transport really can drive the agent loop.
		return { toolCalling: true, imageInput: true };
	}
	if (transport !== 'router') {
		// The CLI transports cannot emit LanguageModelToolCallPart — they run an
		// agent in a subprocess and return its prose. Declaring `toolCalling: false`
		// to say so removed them from the picker entirely, in every mode, because
		// the extension API has no way to express "no tool calls, but still offer
		// me": `LanguageModelChatCapabilities` carries only `imageInput` and
		// `toolCalling`, and the workbench derives `agentMode` from the latter.
		//
		// Being listed is worth more than the distinction. These CLIs do perform
		// real work — Codex reads the workspace and reports back — so an agent-mode
		// turn still returns a useful answer; what the workbench cannot show is the
		// individual tool calls behind it.
		// Images reach these transports as a file path the CLI can open, not as
		// inline bytes, so every one of them can act on an attachment. Declaring
		// `imageInput: false` made the workbench drop the image before the request
		// was even built — the user saw a "Pasted Image" chip and the model saw
		// nothing at all.
		return {
			toolCalling: true,
			imageInput: true
		};
	}
	const protocol = provider.routing?.protocol;
	const supportsTools = protocol === 'openai' || protocol === 'anthropic' || protocol === 'gemini';
	// Must be the same rule the router serialises by. Advertising more than the
	// router will send lets the workbench accept an image the endpoint rejects,
	// and the image then poisons every later turn because it stays in history.
	return {
		toolCalling: supportsTools,
		imageInput: supportsImageInput(provider.id, model)
	};
}

/**
 * Reduces the conversation to Gemini's `contents` shape for Cloud Code.
 *
 * Gemini has only `user` and `model` roles: a system prompt travels separately
 * as `systemInstruction`, and a tool result is a `functionResponse` part on a
 * user turn. Tool calls must be replayed as `functionCall` parts so the model
 * can pair each result with the call that produced it.
 */
function toCloudCodeContents(messages: readonly NormalizedChatMessage[]): CloudCodeTurn[] {
	const contents: CloudCodeTurn[] = [];
	for (const message of messages) {
		if (message.role === 'system') {
			continue;
		}
		if (message.role === 'tool') {
			contents.push({
				role: 'user',
				parts: [{
					functionResponse: {
						name: message.toolCallId ?? 'tool',
						response: { content: contentAsText(message.content) }
					}
				}]
			});
			continue;
		}
		const parts: object[] = [];
		const text = contentAsText(message.content);
		if (text) {
			parts.push({ text });
		}
		for (const call of message.toolCalls ?? []) {
			parts.push({ functionCall: { name: call.name, args: call.arguments } });
		}
		if (parts.length) {
			contents.push({ role: message.role === 'assistant' ? 'model' : 'user', parts });
		}
	}
	return contents;
}

function contentAsText(content: NormalizedChatMessage['content']): string {
	if (typeof content === 'string') {
		return content;
	}
	return content
		.map(part => part.type === 'text' ? part.text ?? '' : `[${part.mimeType ?? 'attachment'}]`)
		.filter(Boolean)
		.join('\n');
}

function asCliPrompt(messages: readonly NormalizedChatMessage[], tools?: readonly NormalizedTool[]): string {
	const parts: string[] = ['Respond to this conversation as a coding assistant. Return only the assistant response.'];

	// Include tool definitions so the CLI knows what tools are available.
	if (tools?.length) {
		parts.push(
			'Available tools (the CLI should use these when needed):',
			...tools.map(tool => `- ${tool.name}: ${tool.description}`)
		);
	}

	for (const message of messages) {
		const roleLabel = message.role === 'system' ? 'System'
			: message.role === 'assistant' ? 'Assistant'
				: message.role === 'tool' ? 'Tool result'
					: 'User';
		const body = formatCliMessageContent(message.content, message.role);
		parts.push(`${roleLabel}:\n${body}`);
	}

	parts.push('Assistant:');
	return parts.join('\n\n');
}

function formatCliMessageContent(
	content: NormalizedChatMessage['content'],
	_role: NormalizedChatMessage['role']
): string {
	if (typeof content === 'string') {
		return content;
	}
	return content.map(part => {
		if (part.type === 'text') {
			return part.text ?? '';
		}
		if (part.type === 'image') {
			// Reached only if materializeImagesForCli could not write the file.
			// Say the image was lost rather than describe it, so the CLI does not
			// answer confidently about something it never saw.
			return '[An image was attached but could not be made available to this CLI.]';
		}
		return '';
	}).filter(Boolean).join('\n');
}


function formatFailureDetail(
	model: BatikCodeModel,
	attempts: readonly { providerId: string; accountId?: string; accountName?: string; reason: string }[] | undefined
): string {
	if (!attempts?.length) {
		return `\n\nCheck that ${model.providerName} is correctly configured and the endpoint is reachable.`;
	}
	const lines = attempts.map((attempt, index) => {
		const label = attempt.accountName
			? `${attempt.providerId} / ${attempt.accountName}`
			: attempt.providerId;
		return `  ${index + 1}. ${label}: ${attempt.reason}`;
	});
	return `\n\nAll attempts failed:\n${lines.join('\n')}\n\nCheck the provider configuration, API key, endpoint URL, and model name.`;
}

function cancellationSignal(token: vscode.CancellationToken): AbortSignal {
	const controller = new AbortController();
	if (token.isCancellationRequested) {
		controller.abort();
	} else {
		token.onCancellationRequested(() => controller.abort());
	}
	return controller.signal;
}
