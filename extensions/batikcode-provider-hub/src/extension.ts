/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { BatikCodeLanguageModelProvider } from './languageModelProvider';
import { OAuthCliBootstrap } from './oauthCliBootstrap';
import { ProviderAccountPool } from './providerAccountPool';
import { MODEL_PROVIDERS, PROVIDERS, ProviderDefinition, providerVendorId } from './providerCatalog';
import { ProviderModelCatalog } from './providerModelCatalog';
import { ProviderChatRequest, ProviderRouter } from './providerRouter';

const HUB_COMMAND = 'batikcode.providerHub.open';
const COPILOT_EXTENSION_IDS = ['GitHub.copilot-chat', 'GitHub.copilot'] as const;
const PROVIDER_ICON_FILES: Readonly<Record<string, string>> = {
	github: 'github.png',
	copilot: 'copilot.svg',
	codex: 'codex.png',
	'gemini-cli': 'gemini-cli.png',
	antigravity: 'antigravity.svg',
	kiro: 'kiro.png',
	openai: 'openai.png',
	anthropic: 'anthropic.png',
	gemini: 'gemini.png',
	openrouter: 'openrouter.png',
	xai: 'xai.png',
	azure: 'azure.png',
	ollama: 'ollama.png',
	deepseek: 'deepseek.png',
	groq: 'groq.png',
	mistral: 'mistral.png',
	together: 'together.svg',
	qwen: 'qwen.png',
	fireworks: 'fireworks.png',
	cerebras: 'cerebras.svg',
	nvidia: 'nvidia.png',
	githubmodels: 'github.png',
	moonshot: 'moonshot.png',
	'zhipu-glm': 'zhipu.png',
	minimax: 'minimax.png',
	siliconflow: 'siliconflow.png',
	perplexity: 'perplexity.png'
};

interface ProviderStatus {
	readonly id: string;
	readonly state: 'connected' | 'configured' | 'available' | 'needsConfiguration' | 'unavailable';
	readonly label: string;
	readonly detail: string;
	readonly modelCount?: number;
	readonly models?: readonly string[];
}

interface HubState {
	readonly providers: readonly ProviderStatus[];
	readonly connectedCount: number;
	readonly githubAccount?: string;
	readonly copilotInstalled: boolean;
}

let currentPanel: vscode.WebviewPanel | undefined;
let refreshInFlight = false;
let providerRouter: ProviderRouter;
let oauthBootstrap: OAuthCliBootstrap;
let providerModelCatalog: ProviderModelCatalog;

export interface BatikCodeProviderHubApi {
	readonly getLanguageModels: () => Promise<readonly vscode.LanguageModelChatInformation[]>;
	readonly getDiagnostics: () => Promise<{
		readonly globalStateKeys: readonly string[];
		readonly deepseek: Awaited<ReturnType<ProviderRouter['getStatus']>>;
		readonly codex: Awaited<ReturnType<OAuthCliBootstrap['getStatus']>>;
		readonly gemini: Awaited<ReturnType<OAuthCliBootstrap['getStatus']>>;
	}>;
}

export function activate(context: vscode.ExtensionContext): BatikCodeProviderHubApi {
	const providerAccountPool = new ProviderAccountPool(context);
	providerModelCatalog = new ProviderModelCatalog(context);
	providerRouter = new ProviderRouter(context, providerAccountPool, providerModelCatalog);
	oauthBootstrap = new OAuthCliBootstrap(context);
	// One provider per upstream vendor, so the model picker attributes every
	// model to the provider that actually serves it instead of collapsing them
	// all under a single hub-wide section.
	const languageModelProviders = MODEL_PROVIDERS.map(provider =>
		new BatikCodeLanguageModelProvider(provider, providerRouter, oauthBootstrap, providerModelCatalog));
	const registrationLog = vscode.window.createOutputChannel('BatikCode Models', { log: true });
	context.subscriptions.push(registrationLog);
	for (const [index, languageModelProvider] of languageModelProviders.entries()) {
		const definition = MODEL_PROVIDERS[index];
		const vendor = providerVendorId(definition.id);
		context.subscriptions.push(languageModelProvider);
		try {
			context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider(vendor, languageModelProvider));
		} catch (error) {
			// A vendor the workbench does not know about throws. Letting that
			// escape aborts activate(), which would take every other provider —
			// and the chat participant — down with it.
			registrationLog.appendLine(
				`[register] ${definition.name} (${vendor}) failed: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}
	registrationLog.appendLine(`[register] ${languageModelProviders.length} provider vendors registered.`);
	context.subscriptions.push(
		vscode.chat.createChatParticipant('batikcode.chat', handleChatRequest),
		vscode.commands.registerCommand(HUB_COMMAND, () => openHub(context)),
		vscode.commands.registerCommand('batikcode.providerHub.connectGitHub', () => connectGitHub(true)),
		vscode.commands.registerCommand('batikcode.providerHub.connectCopilot', () => connectCopilot()),
		vscode.commands.registerCommand('batikcode.providerHub.manageOAuthBootstrap', (providerId?: string) => manageOAuthBootstrap(providerId)),
		vscode.commands.registerCommand('batikcode.providerRouter.configure', (providerId?: string) => configureProviderCommand(providerId)),
		vscode.commands.registerCommand('batikcode.providerRouter.routeChat', (request: ProviderChatRequest) => providerRouter.routeChat(request)),
		vscode.commands.registerCommand('batikcode.providerRouter.test', () => testProviderRouting()),
		vscode.commands.registerCommand('batikcode.providerHub.diagnose', () => diagnoseModels(languageModelProviders)),
		vscode.authentication.onDidChangeSessions(async event => {
			if (event.provider.id === 'github') {
				await refreshPanel();
			}
		}),
		vscode.extensions.onDidChange(() => refreshPanel()),
		context.secrets.onDidChange(() => refreshPanel())
	);
	return {
		getLanguageModels: async () => (
			await Promise.all(languageModelProviders.map(provider => provider.provideLanguageModelChatInformation()))
		).flat(),
		getDiagnostics: async () => ({
			globalStateKeys: context.globalState.keys(),
			deepseek: await providerRouter.getStatus('deepseek'),
			codex: await oauthBootstrap.getStatus('codex-cli'),
			gemini: await oauthBootstrap.getStatus('gemini-cli')
		})
	};
}

/**
 * Reports, per provider, exactly what the model picker is being handed. A model
 * that is configured but missing from the picker leaves no trace otherwise —
 * `provideLanguageModelChatInformation` returning an empty list is
 * indistinguishable from a provider that was never asked.
 */
async function diagnoseModels(providers: readonly BatikCodeLanguageModelProvider[]): Promise<void> {
	const channel = vscode.window.createOutputChannel('BatikCode Provider Diagnostics', { log: true });
	channel.show(true);
	channel.appendLine(`Model report — ${new Date().toISOString()}`);
	channel.appendLine(`${MODEL_PROVIDERS.length} providers registered as language model vendors.`);
	channel.appendLine('');

	let total = 0;
	for (const [index, provider] of providers.entries()) {
		const definition = MODEL_PROVIDERS[index];
		const vendor = providerVendorId(definition.id);
		try {
			const models = await provider.provideLanguageModelChatInformation();
			total += models.length;
			if (models.length) {
				channel.appendLine(`✔ ${definition.name} (${vendor}) — ${models.length} model(s)`);
				for (const model of models) {
					channel.appendLine(`    ${model.id}  ·  tools=${model.capabilities?.toolCalling ?? false}`);
				}
			} else {
				channel.appendLine(`· ${definition.name} (${vendor}) — no models (not configured, or not connected)`);
			}
		} catch (error) {
			channel.appendLine(`✖ ${definition.name} (${vendor}) — FAILED: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	channel.appendLine('');
	channel.appendLine(`${total} model(s) offered to the picker in total.`);
}

/**
 * Cap on tool-call rounds in one turn. A model that keeps requesting tools
 * without ever answering would otherwise loop until the user cancels.
 */
const MAX_TOOL_ROUNDS = 12;

/**
 * Runs one chat turn, including the agent loop: the model may answer directly,
 * or ask for tools — which are executed through {@link vscode.lm.invokeTool} and
 * fed back so it can continue. The registered tools come from whichever
 * extensions contribute them, so BatikCode gains new capabilities without this
 * handler changing.
 */
async function handleChatRequest(
	request: vscode.ChatRequest,
	context: vscode.ChatContext,
	stream: vscode.ChatResponseStream,
	token: vscode.CancellationToken
): Promise<void> {
	const messages = historyToMessages(context.history);
	messages.push(vscode.LanguageModelChatMessage.User(request.prompt));

	// A tool the user explicitly attached must be offered; otherwise offer
	// everything registered so the model can plan its own route.
	const available = request.toolReferences.length
		? vscode.lm.tools.filter(tool => request.toolReferences.some(reference => reference.name === tool.name))
		: vscode.lm.tools;
	const tools: vscode.LanguageModelChatTool[] = available.map(tool => ({
		name: tool.name,
		description: tool.description,
		inputSchema: tool.inputSchema
	}));

	for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
		if (token.isCancellationRequested) {
			return;
		}

		const response = await request.model.sendRequest(
			messages,
			{
				tools,
				toolMode: request.toolReferences.length
					? vscode.LanguageModelChatToolMode.Required
					: vscode.LanguageModelChatToolMode.Auto
			},
			token
		);

		const assistantParts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[] = [];
		const calls: vscode.LanguageModelToolCallPart[] = [];
		for await (const part of response.stream) {
			if (part instanceof vscode.LanguageModelTextPart) {
				stream.markdown(part.value);
				assistantParts.push(part);
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				assistantParts.push(part);
				calls.push(part);
			}
		}

		// No tool was requested, so the model considers the turn answered.
		if (!calls.length) {
			return;
		}

		// The tool calls have to go back verbatim: a provider that matches results
		// to calls by id cannot pair them if the request is dropped from history.
		messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));

		const results: vscode.LanguageModelToolResultPart[] = [];
		for (const call of calls) {
			if (token.isCancellationRequested) {
				return;
			}
			results.push(await invokeToolForChat(call, request.toolInvocationToken, token));
		}
		messages.push(vscode.LanguageModelChatMessage.User(results));
	}

	stream.markdown(vscode.l10n.t(
		'\n\nStopped after {0} rounds of tool calls without a final answer.',
		MAX_TOOL_ROUNDS
	));
}

/**
 * Executes one tool call. A failure is returned to the model as the tool's
 * result rather than thrown: the model can often recover by correcting its
 * input, whereas aborting the turn loses the work done so far.
 */
async function invokeToolForChat(
	call: vscode.LanguageModelToolCallPart,
	toolInvocationToken: vscode.ChatParticipantToolToken,
	token: vscode.CancellationToken
): Promise<vscode.LanguageModelToolResultPart> {
	try {
		const result = await vscode.lm.invokeTool(
			call.name,
			{ input: call.input, toolInvocationToken },
			token
		);
		return new vscode.LanguageModelToolResultPart(call.callId, result.content);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return new vscode.LanguageModelToolResultPart(call.callId, [
			new vscode.LanguageModelTextPart(`Tool "${call.name}" failed: ${message}`)
		]);
	}
}

/** Replays previous turns so the model sees the conversation, not just the last prompt. */
function historyToMessages(history: readonly (vscode.ChatRequestTurn | vscode.ChatResponseTurn)[]): vscode.LanguageModelChatMessage[] {
	const messages: vscode.LanguageModelChatMessage[] = [];
	for (const turn of history) {
		if (turn instanceof vscode.ChatRequestTurn) {
			messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
			continue;
		}
		const text = turn.response
			.filter((part): part is vscode.ChatResponseMarkdownPart => part instanceof vscode.ChatResponseMarkdownPart)
			.map(part => part.value.value)
			.join('');
		if (text) {
			messages.push(vscode.LanguageModelChatMessage.Assistant(text));
		}
	}
	return messages;
}

async function openHub(context: vscode.ExtensionContext): Promise<void> {
	if (currentPanel) {
		currentPanel.reveal(vscode.ViewColumn.Active);
		await refreshPanel();
		return;
	}

	currentPanel = vscode.window.createWebviewPanel(
		'batikcode.providerHub',
		'Accounts & AI Providers',
		vscode.ViewColumn.Active,
		{
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
		}
	);
	currentPanel.iconPath = new vscode.ThemeIcon('circuit-board');
	currentPanel.webview.html = renderHtml(currentPanel.webview, context.extensionUri);
	context.subscriptions.push(currentPanel);
	const panelRefreshTimer = setInterval(() => void refreshPanel(), 5_000);
	currentPanel.onDidDispose(() => {
		currentPanel = undefined;
		clearInterval(panelRefreshTimer);
	}, undefined, context.subscriptions);
	currentPanel.webview.onDidReceiveMessage(message => handleMessage(message), undefined, context.subscriptions);
	await refreshPanel();
}

async function handleMessage(message: { type?: string; provider?: string }): Promise<void> {
	switch (message.type) {
		case 'ready':
		case 'refresh':
			await refreshPanel();
			break;
		case 'connectGitHub':
			await connectGitHub(true);
			await refreshPanel();
			break;
		case 'connectCopilot':
			await connectCopilot();
			await refreshPanel();
			break;
		case 'manageOAuthBootstrap':
			if (message.provider) {
				await manageOAuthBootstrap(message.provider);
				await refreshPanel();
			}
			break;
		case 'configureProvider':
			if (message.provider) {
				await configureProvider(message.provider);
				await refreshPanel();
			}
			break;
		case 'openAccounts':
			await vscode.commands.executeCommand('workbench.actions.accounts');
			break;
	}
}

async function connectGitHub(interactive: boolean): Promise<vscode.AuthenticationSession | undefined> {
	try {
		return await vscode.authentication.getSession(
			'github',
			['user:email'],
			interactive ? { createIfNone: true } : { silent: true }
		);
	} catch (error) {
		if (interactive) {
			void vscode.window.showErrorMessage(`GitHub connection failed: ${errorMessage(error)}`);
		}
		return undefined;
	}
}

async function manageOAuthBootstrap(providerId?: string): Promise<void> {
	if (!providerId) {
		const selection = await vscode.window.showQuickPick([
			{ label: 'GitHub', description: 'GitHub CLI', bootstrapId: 'github-cli' as const },
			...PROVIDERS.filter(provider => provider.oauthBootstrapId).map(provider => ({
				label: provider.name,
				description: 'Official client',
				bootstrapId: provider.oauthBootstrapId!
			}))
		], {
			title: 'OAuth test bootstrap',
			placeHolder: 'Choose an official provider client'
		});
		if (!selection) {
			return;
		}
		await oauthBootstrap.manage(selection.bootstrapId);
		return;
	}
	const provider = PROVIDERS.find(candidate => candidate.id === providerId);
	if (!provider?.oauthBootstrapId) {
		throw new Error(`Provider "${providerId ?? ''}" does not have a local OAuth bootstrap adapter.`);
	}
	const action = await vscode.window.showQuickPick([
		{ label: '$(account) Manage OAuth connection', action: 'oauth' },
		{ label: '$(symbol-array) Configure Chat models', action: 'models' }
	], {
		title: provider.name,
		placeHolder: 'Manage authentication or models'
	});
	if (action?.action === 'oauth') {
		await oauthBootstrap.manage(provider.oauthBootstrapId);
	} else if (action?.action === 'models') {
		const discovered = await oauthBootstrap.getChatModels(provider.oauthBootstrapId);
		await providerModelCatalog.configure(provider.id, provider.name, discovered.map(model => model.id));
	}
}

async function connectCopilot(): Promise<void> {
	const extension = getCopilotExtension();
	if (!extension) {
		const action = await vscode.window.showErrorMessage(
			'GitHub Copilot did not load. Restart BatikCode so its bundled Copilot extension can be registered.',
			'Restart BatikCode'
		);
		if (action === 'Restart BatikCode') {
			await vscode.commands.executeCommand('workbench.action.reloadWindow');
		}
		return;
	}

	try {
		await extension.activate();
		const commands = await vscode.commands.getCommands(true);
		if (commands.includes('github.copilot.chat.triggerPermissiveSignIn')) {
			await vscode.commands.executeCommand('github.copilot.chat.triggerPermissiveSignIn');
		} else {
			await vscode.commands.executeCommand('workbench.action.chat.triggerSetup');
		}
	} catch (error) {
		void vscode.window.showErrorMessage(`Copilot sign-in failed: ${errorMessage(error)}`);
	}
}

function getCopilotExtension(): vscode.Extension<unknown> | undefined {
	for (const id of COPILOT_EXTENSION_IDS) {
		const extension = vscode.extensions.getExtension(id);
		if (extension) {
			return extension;
		}
	}
	return undefined;
}

async function configureProvider(vendor: string): Promise<void> {
	try {
		await providerRouter.configure(vendor);
	} catch (error) {
		void vscode.window.showErrorMessage(`Could not open ${vendor} configuration: ${errorMessage(error)}`);
	}
}

async function configureProviderCommand(providerId?: string): Promise<void> {
	if (!providerId) {
		const selection = await vscode.window.showQuickPick(
			PROVIDERS.filter(provider => provider.routing).map(provider => ({
				label: provider.name,
				description: provider.routing?.protocol,
				providerId: provider.id
			})),
			{
				title: 'Configure API provider',
				placeHolder: 'Choose a provider'
			}
		);
		if (!selection) {
			return;
		}
		providerId = selection.providerId;
	}
	await providerRouter.configure(providerId);
	await refreshPanel();
}

async function testProviderRouting(): Promise<void> {
	const selection = await vscode.window.showQuickPick(
		PROVIDERS.filter(provider => provider.routing).map(provider => ({
			label: provider.name,
			description: provider.routing?.protocol,
			providerId: provider.id
		})),
		{
			title: 'Test provider routing',
			placeHolder: 'This sends a real request that may use provider quota'
		}
	);
	if (!selection) {
		return;
	}
	const prompt = await vscode.window.showInputBox({
		title: `Test ${selection.label}`,
		prompt: 'Enter a short prompt. Fallback and key rotation are applied to this request.',
		ignoreFocusOut: true
	});
	if (!prompt) {
		return;
	}
	try {
		const response = await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: `Testing ${selection.label} routing`,
				cancellable: false
			},
			() => providerRouter.routeChat({
				providerId: selection.providerId,
				messages: [{ role: 'user', content: prompt }],
				maxTokens: 128
			})
		);
		const document = await vscode.workspace.openTextDocument({
			language: 'markdown',
			content: `# BatikCode provider routing test\n\n- Provider: ${response.providerId}\n- Model: ${response.model ?? 'provider default'}\n- Failed attempts before success: ${response.attempts.length}\n\n${response.text || 'The provider returned no text content.'}\n`
		});
		await vscode.window.showTextDocument(document, { preview: true });
	} catch (error) {
		void vscode.window.showErrorMessage(`Provider routing failed: ${errorMessage(error)}`);
	}
}

async function getHubState(): Promise<HubState> {
	const githubSession = await connectGitHub(false);
	const copilotExtension = getCopilotExtension();
	const statuses = await Promise.all(PROVIDERS.map(async provider => {
		try {
			return await getProviderStatus(provider, githubSession, Boolean(copilotExtension));
		} catch (error) {
			return {
				id: provider.id,
				state: 'unavailable' as const,
				label: 'Status unavailable',
				detail: errorMessage(error)
			};
		}
	}));
	return {
		providers: statuses,
		connectedCount: statuses.filter(status => status.state === 'connected').length,
		githubAccount: githubSession?.account.label,
		copilotInstalled: Boolean(copilotExtension)
	};
}

async function getProviderStatus(
	provider: ProviderDefinition,
	githubSession: vscode.AuthenticationSession | undefined,
	copilotInstalled: boolean
): Promise<ProviderStatus> {
	if (provider.action === 'github') {
		return githubSession
			? { id: provider.id, state: 'connected', label: 'Connected', detail: githubSession.account.label }
			: { id: provider.id, state: 'available', label: 'Ready to connect', detail: 'BatikCode OAuth App configured; device-flow sign-in is ready.' };
	}

	if (provider.action === 'oauthBootstrap' && provider.oauthBootstrapId) {
		const status = await oauthBootstrap.getStatus(provider.oauthBootstrapId);
		const discovered = await oauthBootstrap.getChatModels(provider.oauthBootstrapId);
		const models = providerModelCatalog.getModels(provider.id, discovered.map(model => model.id));
		const modelList = [...models];
		return {
			id: provider.id,
			state: status.connected ? 'connected' : status.available ? 'available' : 'unavailable',
			label: status.label,
			detail: status.connected ? `${status.detail} · ${models.length} Chat model${models.length === 1 ? '' : 's'}` : status.detail,
			modelCount: models.length,
			models: modelList.length ? modelList : undefined
		};
	}

	if (provider.action === 'copilot') {
		if (!copilotInstalled) {
			return { id: provider.id, state: 'unavailable', label: 'Not available', detail: 'Copilot is not included in this build.' };
		}
		const models = await selectModels(provider.vendor);
		if (models.length > 0) {
			return { id: provider.id, state: 'connected', label: 'Connected', detail: `${models.length} model${models.length === 1 ? '' : 's'} available`, modelCount: models.length };
		}
		return githubSession
			? { id: provider.id, state: 'available', label: 'Check subscription', detail: 'GitHub is connected; Copilot will verify entitlement during sign-in.' }
			: { id: provider.id, state: 'needsConfiguration', label: 'Sign in required', detail: 'Connect GitHub to verify your Copilot subscription.' };
	}

	if (provider.routing) {
		const status = await providerRouter.getStatus(provider.id);
		if (status.configured) {
			const rotation = status.enabledAccountCount > 1 ? ` · ${status.enabledAccountCount} accounts rotating` : status.enabledAccountCount === 1 ? ' · 1 account' : '';
			const fallback = status.fallbackProviderIds.length ? ` · ${status.fallbackProviderIds.length} fallback${status.fallbackProviderIds.length === 1 ? '' : 's'}` : '';
			const modelList = [...status.models];
			return {
				id: provider.id,
				state: 'configured',
				label: provider.kind === 'local' ? 'Local route configured' : 'Router configured',
				detail: `${status.models.length} Chat model${status.models.length === 1 ? '' : 's'}${rotation}${fallback}`,
				modelCount: status.models.length,
				models: modelList.length ? modelList : undefined
			};
		}
		return {
			id: provider.id,
			state: 'needsConfiguration',
			label: provider.kind === 'local' ? 'Endpoint required' : 'API key required',
			detail: provider.kind === 'local'
				? 'Configure the local endpoint and model.'
				: 'Add one or more keys. BatikCode stores them in the credential vault and rotates them per request.'
		};
	}

	const models = await selectModels(provider.vendor);
	if (models.length > 0) {
		return {
			id: provider.id,
			state: 'connected',
			label: provider.kind === 'local' ? 'Local models ready' : 'Configured',
			detail: `${models.length} model${models.length === 1 ? '' : 's'} available`,
			modelCount: models.length
		};
	}

	return {
		id: provider.id,
		state: 'needsConfiguration',
		label: provider.kind === 'local' ? 'Endpoint required' : 'API key required',
		detail: provider.kind === 'local' ? 'Configure a local endpoint and select a model.' : 'Your key will be stored in the operating system credential vault.'
	};
}

async function selectModels(vendor: string | undefined): Promise<readonly vscode.LanguageModelChat[]> {
	if (!vendor) {
		return [];
	}
	try {
		return await Promise.race([
			vscode.lm.selectChatModels({ vendor }),
			new Promise<readonly vscode.LanguageModelChat[]>(resolve => setTimeout(() => resolve([]), 3_000))
		]);
	} catch {
		return [];
	}
}

async function refreshPanel(): Promise<void> {
	if (!currentPanel || refreshInFlight) {
		return;
	}
	refreshInFlight = true;
	try {
		const state = await getHubState();
		await currentPanel.webview.postMessage({ type: 'state', state });
	} finally {
		refreshInFlight = false;
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function nonce(): string {
	const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let value = '';
	for (let index = 0; index < 32; index++) {
		value += characters.charAt(Math.floor(Math.random() * characters.length));
	}
	return value;
}

function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
	const scriptNonce = nonce();
	const catalog = JSON.stringify(PROVIDERS.map(provider => {
		const iconFile = PROVIDER_ICON_FILES[provider.id];
		return {
			...provider,
			iconUri: iconFile
				? webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'providers', iconFile)).toString()
				: undefined
		};
	})).replace(/</g, '\\u003c');
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${scriptNonce}';">
	<title>Accounts & AI Providers</title>
	<style>
		:root { color-scheme: light dark; }
		* { box-sizing: border-box; }
		body {
			margin: 0;
			color: var(--vscode-foreground);
			background: var(--vscode-editor-background);
			font: 13px/1.45 var(--vscode-font-family);
	}
		button, input { font: inherit; }
		button:focus-visible, input:focus-visible {
			outline: 1px solid var(--vscode-focusBorder);
			outline-offset: 2px;
		}
		.shell { min-height: 100vh; }
		.hero {
			display: grid;
			grid-template-columns: minmax(280px, 1fr) auto;
			gap: 24px;
			align-items: end;
			padding: 30px 36px 24px;
			border-bottom: 1px solid var(--vscode-panel-border);
			background:
				linear-gradient(110deg, color-mix(in srgb, var(--vscode-editor-background) 88%, #4c79ff 12%), var(--vscode-editor-background) 60%);
		}
		.eyebrow {
			margin: 0 0 8px;
			color: var(--vscode-descriptionForeground);
			font-size: 11px;
			font-weight: 600;
			letter-spacing: .12em;
			text-transform: uppercase;
		}
		h1 { margin: 0; font-size: 25px; font-weight: 560; letter-spacing: -.025em; }
		.hero-copy { max-width: 680px; margin: 8px 0 0; color: var(--vscode-descriptionForeground); }
		.summary { display: flex; gap: 8px; }
		.metric {
			min-width: 86px;
			padding: 9px 12px;
			border: 1px solid var(--vscode-panel-border);
			background: color-mix(in srgb, var(--vscode-editor-background) 86%, transparent);
		}
		.metric strong { display: block; font-size: 18px; font-weight: 600; }
		.metric span { color: var(--vscode-descriptionForeground); font-size: 11px; }
		.toolbar {
			display: flex;
			align-items: center;
			gap: 8px;
			padding: 10px 36px;
			border-bottom: 1px solid var(--vscode-panel-border);
			background: var(--vscode-sideBar-background);
		}
		.search {
			width: min(360px, 55vw);
			height: 28px;
			padding: 0 9px;
			color: var(--vscode-input-foreground);
			background: var(--vscode-input-background);
			border: 1px solid var(--vscode-input-border, transparent);
		}
		.spacer { flex: 1; }
		.button {
			min-height: 28px;
			padding: 4px 11px;
			color: var(--vscode-button-foreground);
			background: var(--vscode-button-background);
			border: 0;
			cursor: pointer;
		}
		.button:hover { background: var(--vscode-button-hoverBackground); }
		.button.secondary {
			color: var(--vscode-foreground);
			background: transparent;
			border: 1px solid var(--vscode-panel-border);
		}
		.button.secondary:hover { background: var(--vscode-toolbar-hoverBackground); }
		.content { padding: 25px 36px 40px; }
		.section-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 12px; }
		h2 { margin: 0; font-size: 14px; font-weight: 600; }
		.section-note { color: var(--vscode-descriptionForeground); font-size: 12px; }
		.grid {
			display: grid;
			grid-template-columns: repeat(auto-fill, minmax(285px, 1fr));
			gap: 10px;
		}
		.card {
			position: relative;
			display: grid;
			grid-template-columns: 38px minmax(0, 1fr);
			gap: 12px;
			min-height: 148px;
			padding: 15px;
			border: 1px solid var(--vscode-panel-border);
			background: var(--vscode-sideBar-background);
		}
		.card:hover { border-color: color-mix(in srgb, var(--vscode-focusBorder) 65%, var(--vscode-panel-border)); }
		.provider-mark {
			display: grid;
			place-items: center;
			width: 38px;
			height: 38px;
			border: 1px solid color-mix(in srgb, var(--accent) 55%, var(--vscode-panel-border));
			color: var(--accent);
			background: color-mix(in srgb, var(--accent) 10%, transparent);
			font-size: 11px;
			font-weight: 700;
			letter-spacing: .03em;
		}
		.provider-mark.has-logo { background: color-mix(in srgb, var(--vscode-editor-background) 88%, white 12%); }
		.provider-mark img { display: block; width: 25px; height: 25px; object-fit: contain; }
		.provider-mark.has-logo .provider-fallback { display: none; }
		.card h3 { margin: 1px 0 2px; font-size: 13px; font-weight: 600; }
		.kind { color: var(--vscode-descriptionForeground); font-size: 11px; text-transform: capitalize; }
		.description { grid-column: 1 / -1; min-height: 36px; margin: 0; color: var(--vscode-descriptionForeground); font-size: 12px; }
		.card-footer { grid-column: 1 / -1; display: flex; align-items: center; gap: 8px; }
		.status { display: inline-flex; align-items: center; gap: 6px; min-width: 0; margin-right: auto; font-size: 11px; }
		.status-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--vscode-descriptionForeground); }
		.status.connected .status-dot { background: var(--vscode-testing-iconPassed, #73c991); box-shadow: 0 0 0 3px color-mix(in srgb, var(--vscode-testing-iconPassed, #73c991) 14%, transparent); }
		.status.configured .status-dot { background: var(--vscode-charts-blue, #3794ff); box-shadow: 0 0 0 3px color-mix(in srgb, var(--vscode-charts-blue, #3794ff) 14%, transparent); }
		.status.needsConfiguration .status-dot { background: var(--vscode-editorWarning-foreground, #cca700); }
		.status.unavailable .status-dot { background: var(--vscode-errorForeground); }
		.status-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.card .button { font-size: 11px; }
		.security {
			display: grid;
			grid-template-columns: auto 1fr;
			gap: 10px;
			margin-top: 22px;
			padding: 13px 15px;
			border-left: 2px solid var(--vscode-focusBorder);
			background: color-mix(in srgb, var(--vscode-focusBorder) 7%, var(--vscode-editor-background));
		}
		.security strong { font-size: 12px; }
		.security p { margin: 2px 0 0; color: var(--vscode-descriptionForeground); font-size: 12px; }
		.model-list { grid-column: 1 / -1; margin: 4px 0 0; color: var(--vscode-descriptionForeground); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.empty { display: none; padding: 30px 0; color: var(--vscode-descriptionForeground); }
		.loading .status-label { opacity: .65; }
		@media (max-width: 700px) {
			.hero { grid-template-columns: 1fr; padding: 24px 20px 20px; }
			.toolbar, .content { padding-left: 20px; padding-right: 20px; }
			.summary { justify-content: flex-start; }
		}
	</style>
</head>
<body class="loading">
	<div class="shell">
		<header class="hero">
			<div>
				<p class="eyebrow">BatikCode connections</p>
				<h1>Accounts & AI Providers</h1>
				<p class="hero-copy">One place for GitHub, Copilot, API-key models, local models, and standards-compatible endpoints.</p>
			</div>
			<div class="summary" aria-label="Connection summary">
				<div class="metric"><strong id="connected-count">—</strong><span>connected</span></div>
				<div class="metric"><strong id="provider-count">${PROVIDERS.length}</strong><span>providers</span></div>
			</div>
		</header>
		<div class="toolbar">
			<input id="search" class="search" type="search" placeholder="Filter providers" aria-label="Filter providers">
			<div class="spacer"></div>
			<button class="button secondary" data-message="openAccounts">Accounts</button>
			<button class="button secondary" data-message="refresh">Refresh</button>
		</div>
		<main class="content">
			<div class="section-head">
				<h2>Available connections</h2>
				<span class="section-note">Only functional adapters are shown</span>
			</div>
			<div id="grid" class="grid"></div>
			<div id="empty" class="empty">No providers match this filter.</div>
			<div class="security">
				<span aria-hidden="true">◆</span>
				<div>
					<strong>Secrets stay in the credential vault</strong>
					<p>API keys use BatikCode SecretStorage. OAuth bootstrap sessions stay inside each official client and BatikCode never copies their tokens.</p>
				</div>
			</div>
			<div class="security">
				<span aria-hidden="true">!</span>
				<div>
					<strong>Temporary local testing mode</strong>
					<p>CLI bootstrap avoids registering OAuth apps during private development. Replace it with deployment-owned OAuth clients before public distribution.</p>
				</div>
			</div>
		</main>
	</div>
	<script nonce="${scriptNonce}">
		const vscode = acquireVsCodeApi();
		const catalog = ${catalog};
		let statuses = new Map();

		function actionFor(provider) {
			if (provider.action === 'github') return ['connectGitHub', statuses.get(provider.id)?.state === 'connected' ? 'Reconnect' : 'Connect'];
			if (provider.action === 'copilot') return ['connectCopilot', statuses.get(provider.id)?.state === 'connected' ? 'Manage' : 'Sign in'];
			if (provider.action === 'oauthBootstrap') return ['manageOAuthBootstrap', statuses.get(provider.id)?.state === 'connected' ? 'Manage' : 'Sign in'];
			return ['configureProvider', ['connected', 'configured'].includes(statuses.get(provider.id)?.state) ? 'Manage' : 'Configure'];
		}

		function element(tag, className, text) {
			const node = document.createElement(tag);
			if (className) node.className = className;
			if (text !== undefined) node.textContent = String(text);
			return node;
		}

		function render(filter = '') {
			const query = filter.trim().toLowerCase();
			const visible = catalog.filter(provider =>
				!query || provider.name.toLowerCase().includes(query) || provider.description.toLowerCase().includes(query)
			);
			document.getElementById('empty').style.display = visible.length ? 'none' : 'block';
			const cards = visible.map(provider => {
				const status = statuses.get(provider.id) || {
					state: 'available',
					label: 'Checking…',
					detail: 'Checking provider availability.'
				};
				const [message, actionLabel] = actionFor(provider);
				const card = element('article', 'card');
				card.style.setProperty('--accent', provider.accent);
				const mark = element('div', \`provider-mark \${provider.iconUri ? 'has-logo' : ''}\`);
				if (provider.iconUri) {
					const image = element('img');
					image.src = provider.iconUri;
					image.alt = '';
					image.setAttribute('aria-hidden', 'true');
					mark.append(image);
				}
				mark.append(element('span', 'provider-fallback', provider.shortName));
				const heading = element('div');
				heading.append(
					element('h3', '', provider.name),
					element('div', 'kind', provider.kind === 'apiKey' ? 'API key' : provider.kind)
				);
				const footer = element('div', 'card-footer');
				const statusNode = element('div', \`status \${status.state}\`);
				statusNode.title = status.detail;
				statusNode.append(element('span', 'status-dot'), element('span', 'status-label', status.label));
				const button = element('button', 'button secondary provider-action', actionLabel);
				button.dataset.message = message;
				button.dataset.provider = provider.id;
				footer.append(statusNode, button);
				card.append(mark, heading, element('p', 'description', provider.description), footer);
				if (status.models?.length) {
					const modelList = element('p', 'model-list');
					modelList.textContent = 'Models: ' + status.models.join(', ');
					card.append(modelList);
				}
				return card;
			});
			document.getElementById('grid').replaceChildren(...cards);
		}

		document.addEventListener('click', event => {
			const button = event.target.closest('button[data-message]');
			if (!button) return;
			vscode.postMessage({ type: button.dataset.message, provider: button.dataset.provider });
		});
		document.addEventListener('error', event => {
			const image = event.target;
			if (!(image instanceof HTMLImageElement) || !image.closest('.provider-mark')) return;
			image.parentElement?.classList.remove('has-logo');
			image.remove();
		}, true);
		document.getElementById('search').addEventListener('input', event => render(event.target.value));
		window.addEventListener('message', event => {
			if (event.data?.type !== 'state') return;
			statuses = new Map(event.data.state.providers.map(status => [status.id, status]));
			document.getElementById('connected-count').textContent = String(event.data.state.connectedCount);
			document.body.classList.remove('loading');
			render(document.getElementById('search').value);
		});
		render();
		vscode.postMessage({ type: 'ready' });
	</script>
</body>
</html>`;
}
