/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

const MAX_HISTORY_PAIRS = 20;
/**
 * The Provider Hub registers one vendor per upstream provider
 * (`batikcode-openai`, `batikcode-anthropic`, …) so the model picker can name
 * the provider that actually serves a model. There is no single `batikcode`
 * vendor to select on, so its models are recognised by this prefix.
 */
const BATIKCODE_VENDOR_PREFIX = 'batikcode-';

function isBatikCodeModel(model: vscode.LanguageModelChat): boolean {
	return model.vendor.startsWith(BATIKCODE_VENDOR_PREFIX);
}

/** Vendor ids whose title-cased form reads wrong ("Openai", "Xai"). */
const PROVIDER_LABEL_OVERRIDES: Readonly<Record<string, string>> = {
	openai: 'OpenAI',
	xai: 'xAI',
	deepseek: 'DeepSeek',
	openrouter: 'OpenRouter',
	githubmodels: 'GitHub Models',
	nvidia: 'NVIDIA NIM',
	deepinfra: 'DeepInfra',
	siliconflow: 'SiliconFlow',
	minimax: 'MiniMax',
	sambanova: 'SambaNova',
	'zhipu-glm': 'Zhipu GLM',
	customendpoint: 'Custom endpoint',
	codex: 'OpenAI Codex',
	'gemini-cli': 'Gemini CLI',
	azure: 'Azure OpenAI'
};

/**
 * A human-readable provider name for a model, so `/models` names the provider
 * that actually serves it rather than exposing the internal vendor id.
 */
function providerLabel(model: vscode.LanguageModelChat): string {
	if (!isBatikCodeModel(model)) {
		return model.vendor;
	}
	const id = model.vendor.slice(BATIKCODE_VENDOR_PREFIX.length);
	return PROVIDER_LABEL_OVERRIDES[id]
		?? id.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}
const GET_SELECTED_CHAT_MODEL_COMMAND = '_chat.getSelectedModelIdentifier';

export interface TelegramAIModelInfo {
	readonly vendor: string;
	readonly family: string;
	readonly id: string;
	readonly name: string;
}

interface ChatSession {
	readonly chatId: string;
	messages: vscode.LanguageModelChatMessage[];
}

export class TelegramAIChat implements vscode.Disposable {
	private model: vscode.LanguageModelChat | undefined;
	private sessions = new Map<string, ChatSession>();
	private modelListener: vscode.Disposable | undefined;

	constructor(
		private readonly output: vscode.OutputChannel
	) { }

	/**
	 * Selected model summary for /status and diagnostics.
	 */
	public getModelInfo(): TelegramAIModelInfo | undefined {
		if (!this.model) {
			return undefined;
		}
		return {
			vendor: this.model.vendor,
			family: this.model.family,
			id: this.model.id,
			name: this.model.name ?? this.model.id
		};
	}

	/**
	 * Drop the cached model so the next request re-queries the catalog.
	 */
	public invalidateModel(): void {
		this.model = undefined;
	}

	/**
	 * Lists all available AI models with their index for /model selection.
	 */
	public async listAvailableModels(): Promise<string> {
		try {
			const models = await vscode.lm.selectChatModels();
			if (models.length === 0) {
				return 'No AI models available. Add a provider in BatikCode Account & AI Provider Hub.';
			}
			const current = this.model;
			const lines = models.map((m, i) => {
				// allow-any-unicode-next-line
				const active = current && m.id === current.id ? ' ✅ (active)' : '';
				const auto = isAutoSelectionModel(m) ? ' (auto router)' : '';
				return `${i + 1}. ${m.name ?? m.id} — ${providerLabel(m)}${auto}${active}`;
			});
			return `Available AI models:

${lines.join('\n')}

To switch: /model <number>
To return to automatic selection: /model auto`;
		} catch (error) {
			return `Error listing models: ${error instanceof Error ? error.message : String(error)}`;
		}
	}

	/**
	 * Selects a model by 1-based index from listAvailableModels.
	 * Returns a description of the newly selected model.
	 */
	public async selectModelByIndex(index: number): Promise<string> {
		const models = await vscode.lm.selectChatModels();
		const model = models[index - 1];
		if (!model) {
			return `Invalid model number. Use /models to see the list (1-${models.length}).`;
		}
		this.model = model;
		this.output.appendLine(`[telegram-ai] user switched model to: ${model.vendor}/${model.family}/${model.name ?? model.id}`);
		const config = vscode.workspace.getConfiguration('batikcode.telegram');
		await config.update('preferredModelId', model.id, vscode.ConfigurationTarget.Global);
		return `Switched to: ${model.name ?? model.id} — ${providerLabel(model)}\n\nThis preference is saved in BatikCode settings.`;
	}

	public async clearModelPreference(): Promise<string> {
		this.model = undefined;
		const config = vscode.workspace.getConfiguration('batikcode.telegram');
		await Promise.all([
			config.update('preferredModelId', '', vscode.ConfigurationTarget.Global),
			config.update('preferredModelFamily', '', vscode.ConfigurationTarget.Global)
		]);
		const model = await this.ensureModel();
		return `Automatic model selection restored.\n\nCurrent Telegram model: ${model.name ?? model.id} — ${providerLabel(model)}`;
	}

	public async getUiSelectedModelIdentifier(): Promise<string | undefined> {
		try {
			const result = await vscode.commands.executeCommand<string | undefined>(GET_SELECTED_CHAT_MODEL_COMMAND);
			return result?.trim() || undefined;
		} catch (error) {
			this.output.appendLine(`[telegram-ai] could not read active UI chat model: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}
	}

	/**
	 * Ensures an AI model is selected and returns it.
	 * Prefers BatikCode Provider Hub models (`vendor: batikcode`).
	 */
	public async ensureModel(): Promise<vscode.LanguageModelChat> {
		if (this.model) {
			return this.model;
		}

		const config = vscode.workspace.getConfiguration('batikcode.telegram');
		const preferredModelId = (config.get<string>('preferredModelId', '') || '').trim();
		const preferredFamily = (config.get<string>('preferredModelFamily', '') || '').trim();
		const uiSelectedModelId = !preferredModelId && !preferredFamily
			? await this.getUiSelectedModelIdentifier()
			: undefined;

		// One query, then filter: the selector matches a vendor exactly, and the
		// hub's models are spread across one vendor per provider.
		const available = await vscode.lm.selectChatModels();
		const batikcodeModels = available.filter(isBatikCodeModel);
		const allModels = batikcodeModels.length ? batikcodeModels : available;

		if (allModels.length === 0) {
			throw new Error(
				'No AI model is available in BatikCode. Open Account & AI Provider Hub, add an API key or local provider, then reload the window.'
			);
		}

		const selected =
			(preferredModelId
				? allModels.find(model => matchesModelSelection(model, preferredModelId))
				: undefined)
			?? (uiSelectedModelId
				? allModels.find(model => matchesModelSelection(model, uiSelectedModelId))
				: undefined)
			?? (preferredFamily
				? allModels.find(model => model.family === preferredFamily || model.id.includes(preferredFamily))
				: undefined)
			?? preferBatikCodeModel(allModels);

		const concreteModel = resolveConcreteModel(selected, allModels);
		this.model = concreteModel;
		this.output.appendLine(
			`[telegram-ai] selected model: ${this.model.vendor}/${this.model.family}/${this.model.name ?? this.model.id}`
		);
		if (uiSelectedModelId && !preferredModelId && !preferredFamily) {
			this.output.appendLine(`[telegram-ai] following active BatikCode chat model selection: ${uiSelectedModelId}`);
		}
		if (concreteModel.id !== selected.id) {
			this.output.appendLine(
				`[telegram-ai] resolved auto model ${selected.vendor}/${selected.id} to concrete model ${concreteModel.vendor}/${concreteModel.id}`
			);
		}

		this.modelListener ??= vscode.lm.onDidChangeChatModels(() => {
			this.model = undefined;
			this.output.appendLine('[telegram-ai] model list changed, will re-query on next request');
		});

		return this.model;
	}

	/**
	 * Sends a natural-language message to the AI model, maintaining
	 * conversation history per Telegram chat.
	 *
	 * @returns The full text response.
	 */
	public async chat(
		chatId: string,
		text: string,
		onProgress?: (chunk: string) => void
	): Promise<string> {
		let model = await this.ensureModel();
		const session = this.sessions.get(chatId);

		const messages: vscode.LanguageModelChatMessage[] = [];
		messages.push(this.makeSystemMessage());
		if (session?.messages.length) {
			messages.push(...session.messages);
		}
		messages.push(vscode.LanguageModelChatMessage.User(text));

		let fullResponse = '';
		try {
			fullResponse = await this.sendChatRequest(model, messages, onProgress);
		} catch (error) {
			const fallbackModel = await this.findConcreteFallbackModel(model);
			if (fallbackModel && fallbackModel.id !== model.id) {
				this.output.appendLine(
					`[telegram-ai] model request failed via ${model.vendor}/${model.id}: ${error instanceof Error ? error.message : String(error)}; retrying with ${fallbackModel.vendor}/${fallbackModel.id}`
				);
				model = fallbackModel;
				this.model = fallbackModel;
				fullResponse = await this.sendChatRequest(model, messages, onProgress);
			} else {
				throw error;
			}
		}
		if (!fullResponse.trim()) {
			const fallbackModel = await this.findConcreteFallbackModel(model);
			if (fallbackModel && fallbackModel.id !== model.id) {
				this.output.appendLine(
					`[telegram-ai] empty text response via ${model.vendor}/${model.id}; retrying with ${fallbackModel.vendor}/${fallbackModel.id}`
				);
				model = fallbackModel;
				this.model = fallbackModel;
				fullResponse = await this.sendChatRequest(model, messages, onProgress);
			}
		}

		if (!fullResponse.trim()) {
			fullResponse = '(The model returned an empty response.)';
		}

		const userMsg = vscode.LanguageModelChatMessage.User(text);
		const assistantMsg = vscode.LanguageModelChatMessage.Assistant(fullResponse);

		if (session) {
			session.messages.push(userMsg, assistantMsg);
			this.trimHistory(session);
		} else {
			this.sessions.set(chatId, {
				chatId,
				messages: [userMsg, assistantMsg]
			});
		}

		this.output.appendLine(
			`[telegram-ai] chat ${chatId}: "${text.slice(0, 60)}…" → ${fullResponse.length} chars via ${model.vendor}/${model.id}`
		);
		return fullResponse;
	}

	public clearHistory(chatId: string): void {
		this.sessions.delete(chatId);
		this.output.appendLine(`[telegram-ai] cleared conversation history for chat ${chatId}`);
	}

	public exchangeCount(chatId: string): number {
		return (this.sessions.get(chatId)?.messages.length ?? 0) / 2;
	}

	public dispose(): void {
		this.modelListener?.dispose();
		this.modelListener = undefined;
		this.sessions.clear();
		this.model = undefined;
	}

	private async sendChatRequest(
		model: vscode.LanguageModelChat,
		messages: vscode.LanguageModelChatMessage[],
		onProgress?: (chunk: string) => void
	): Promise<string> {
		let response: vscode.LanguageModelChatResponse;
		try {
			response = await model.sendRequest(messages, {
				justification: 'BatikCode Telegram bot uses a BatikCode language model to answer messages from an authorized paired Telegram user.'
			});
		} catch {
			// Model may have disappeared after provider reload; retry once with a fresh pick.
			this.model = undefined;
			const retryModel = await this.ensureModel();
			response = await retryModel.sendRequest(messages, {
				justification: 'BatikCode Telegram bot uses a BatikCode language model to answer messages from an authorized paired Telegram user.'
			});
			model = retryModel;
		}

		let fullResponse = '';
		for await (const chunk of response.text) {
			fullResponse += chunk;
			onProgress?.(chunk);
		}

		return fullResponse;
	}

	private async findConcreteFallbackModel(currentModel: vscode.LanguageModelChat): Promise<vscode.LanguageModelChat | undefined> {
		const models = await vscode.lm.selectChatModels();
		const sameVendorConcrete = models.filter(model => model.vendor === currentModel.vendor && !isAutoSelectionModel(model));
		if (sameVendorConcrete.length) {
			return preferBatikCodeModel(sameVendorConcrete);
		}

		const anyConcrete = models.filter(model => !isAutoSelectionModel(model));
		return anyConcrete.length ? preferBatikCodeModel(anyConcrete) : undefined;
	}

	private makeSystemMessage(): vscode.LanguageModelChatMessage {
		const workspace = vscode.workspace.workspaceFolders?.[0];
		const workspaceContext = workspace
			? `Current workspace: "${workspace.name}" (${workspace.uri.fsPath})`
			: 'No workspace is currently open.';
		const model = this.model;
		const modelContext = model
			? `Active BatikCode model: ${model.name ?? model.id} — ${providerLabel(model)}`
			: 'Active BatikCode model: unknown';

		const prompt = [
			'You are BatikBot, an AI coding assistant integrated with BatikCode via Telegram.',
			'You help users with coding tasks, answer questions about their project, and assist with software engineering work.',
			'You are running inside BatikCode (not BatikCode). Identify yourself as BatikCode / BatikBot when asked.',
			'',
			workspaceContext,
			modelContext,
			'',
			'Guidelines:',
			'- Be concise but thorough. Provide specific code examples when relevant.',
			'- Use markdown formatting: ``` for code blocks, **bold** for emphasis.',
			'- You can discuss code and suggest edits. You cannot directly modify files from chat.',
			'- If the user wants BatikCode to apply edits in the open workspace, tell them to send: /code <task description>',
			'- If you cannot answer something, say so honestly.',
			'- Keep responses under Telegram message limits when possible (prefer under 3500 characters).'
		].join('\n');

		return vscode.LanguageModelChatMessage.User(prompt);
	}

	private trimHistory(session: ChatSession): void {
		const pairs = session.messages.length / 2;
		if (pairs > MAX_HISTORY_PAIRS) {
			const excess = (pairs - MAX_HISTORY_PAIRS) * 2;
			session.messages.splice(0, excess);
		}
	}
}

function preferBatikCodeModel(models: readonly vscode.LanguageModelChat[]): vscode.LanguageModelChat {
	const batikcode = models.filter(isBatikCodeModel);
	const pool = batikcode.length ? batikcode : models;
	const ranked = [...pool].sort((a, b) => scoreModel(b) - scoreModel(a));
	return ranked[0];
}

function resolveConcreteModel(
	selected: vscode.LanguageModelChat,
	models: readonly vscode.LanguageModelChat[]
): vscode.LanguageModelChat {
	if (!isAutoSelectionModel(selected)) {
		return selected;
	}

	const sameVendorConcrete = models.filter(model => model.vendor === selected.vendor && !isAutoSelectionModel(model));
	if (sameVendorConcrete.length) {
		return preferBatikCodeModel(sameVendorConcrete);
	}

	const anyConcrete = models.filter(model => !isAutoSelectionModel(model));
	return anyConcrete.length ? preferBatikCodeModel(anyConcrete) : selected;
}

function matchesModelSelection(model: vscode.LanguageModelChat, selection: string): boolean {
	const normalizedSelection = selection.trim().toLowerCase();
	const modelName = (model.name ?? '').trim().toLowerCase();
	const modelId = model.id.trim().toLowerCase();
	const qualifiedId = `${model.vendor}/${model.id}`.toLowerCase();
	return normalizedSelection === modelId
		|| normalizedSelection === modelName
		|| normalizedSelection === qualifiedId;
}

function isAutoSelectionModel(model: vscode.LanguageModelChat): boolean {
	const name = (model.name ?? '').trim().toLowerCase();
	const id = model.id.trim().toLowerCase();
	const family = model.family.trim().toLowerCase();
	return name === 'auto'
		|| id === 'auto'
		|| id.endsWith('/auto')
		|| family === 'auto';
}

export function normalizeModelSelection(value: string): string {
	return value.trim().toLowerCase();
}

function scoreModel(model: vscode.LanguageModelChat): number {
	let score = 0;
	if (isBatikCodeModel(model)) {
		score += 100;
	}
	const id = `${model.family} ${model.id} ${model.name ?? ''}`.toLowerCase();
	if (id.includes('flash') || id.includes('mini') || id.includes('haiku') || id.includes('small')) {
		score += 20;
	}
	if (id.includes('coder') || id.includes('code')) {
		score += 10;
	}
	return score;
}