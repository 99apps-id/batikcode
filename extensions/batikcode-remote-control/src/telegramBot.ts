/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { normalizeModelSelection, TelegramAIChat } from './telegramAI';
import { CodexTaskRunner } from './codexRunner';
import { TelegramApi, TelegramApiError, TelegramMessage, TelegramUpdate, TelegramUser } from './telegramApi';
import { evaluatePairing, isAuthorizedTelegramUser, parseUserIds } from './telegramSecurity';

const execFileAsync = promisify(execFile);
const TOKEN_SECRET_KEY = 'batikcode.telegram.botToken';
const ALLOWED_USERS_STATE_KEY = 'batikcode.telegram.allowedUserIds';
const LEGACY_ALLOWED_CHATS_STATE_KEY = 'batikcode.telegram.allowedChatIds';
const WORKSPACE_EDITING_STATE_KEY = 'batikcode.telegram.workspaceEditingEnabled';
const UPDATE_OFFSET_STATE_KEY = 'batikcode.telegram.updateOffset';
const MAX_PROMPT_LENGTH = 4000;
const PAIRING_TTL_MS = 10 * 60_000;

export type TelegramConnectionState = 'offline' | 'connecting' | 'online' | 'busy' | 'error';

export interface TelegramBotState {
	readonly connection: TelegramConnectionState;
	readonly label: string;
	readonly detail: string;
	readonly username?: string;
	readonly allowedUserCount: number;
	readonly workspaceEditingEnabled: boolean;
	readonly taskRunning: boolean;
}

interface PairingChallenge {
	readonly code: string;
	readonly expiresAt: number;
}

export class TelegramBotController implements vscode.Disposable {
	private readonly stateEmitter = new vscode.EventEmitter<TelegramBotState>();
	readonly onDidChangeState = this.stateEmitter.event;

	private readonly runner = new CodexTaskRunner();
	private readonly ai: TelegramAIChat;
	private abortController: AbortController | undefined;
	private cancellationSource: vscode.CancellationTokenSource | undefined;
	private api: TelegramApi | undefined;
	private botUser: TelegramUser | undefined;
	private pairingChallenge: PairingChallenge | undefined;
	private disposed = false;
	private currentState: TelegramBotState;
	private readonly instanceId = randomBytes(16).toString('hex');

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly output: vscode.OutputChannel
	) {
		this.ai = new TelegramAIChat(this.output);
		this.currentState = this.createState('offline', 'Offline', 'Bot token is not configured or the bot is stopped.');
	}

	public get state(): TelegramBotState {
		return this.currentState;
	}

	public async initialize(): Promise<void> {
		if (this.context.globalState.get<readonly string[]>(LEGACY_ALLOWED_CHATS_STATE_KEY, []).length) {
			await this.context.globalState.update(LEGACY_ALLOWED_CHATS_STATE_KEY, undefined);
			await this.context.globalState.update(WORKSPACE_EDITING_STATE_KEY, false);
			this.output.appendLine('[telegram] removed legacy chat-ID authorization; users must pair again');
		}
		const token = await this.context.secrets.get(TOKEN_SECRET_KEY);
		if (!token) {
			this.updateState('offline', 'Offline', 'Configure a BotFather token to start.');
			return;
		}
		this.updateState('offline', 'Offline', 'Token stored. Bot is stopped.');
		if (vscode.workspace.getConfiguration('batikcode.telegram').get<boolean>('autoStart', true)) {
			void this.start();
		}
	}

	public async configureToken(): Promise<void> {
		const token = await vscode.window.showInputBox({
			title: 'Telegram BotFather Token',
			prompt: 'Paste the token from @BotFather. It will be validated and stored in the operating-system credential vault.',
			password: true,
			ignoreFocusOut: true,
			validateInput: value => validateBotToken(value)
		});
		if (token === undefined) {
			return;
		}

		this.updateState('connecting', 'Validating…', 'Checking the token with Telegram.');
		try {
			const api = new TelegramApi(token.trim());
			const user = await api.getMe();
			this.stop(false);
			await this.context.secrets.store(TOKEN_SECRET_KEY, token.trim());
			await this.resetAuthorization();
			this.output.appendLine(`[telegram] token validated for bot id ${user.id}`);
			await this.start();
			void vscode.window.showInformationMessage(`Telegram bot @${user.username ?? user.first_name} is online.`);
		} catch (error) {
			this.updateState('error', 'Token invalid', safeErrorMessage(error));
			void vscode.window.showErrorMessage(`Telegram token validation failed: ${safeErrorMessage(error)}`);
		}
	}

	public async removeToken(): Promise<void> {
		const confirmation = await vscode.window.showWarningMessage(
			'Remove the Telegram BotFather token and stop remote control?',
			{ modal: true },
			'Remove Token'
		);
		if (confirmation !== 'Remove Token') {
			return;
		}
		this.stop();
		await this.context.secrets.delete(TOKEN_SECRET_KEY);
		await this.resetAuthorization();
		this.updateState('offline', 'Offline', 'Bot token removed.');
	}

	public async start(): Promise<void> {
		this.stop(false);
		const token = await this.context.secrets.get(TOKEN_SECRET_KEY);
		if (!token) {
			this.updateState('offline', 'Offline', 'Configure a BotFather token first.');
			void vscode.window.showWarningMessage('Telegram BotFather token is not configured.', 'Configure Token')
				.then(action => action === 'Configure Token' ? this.configureToken() : undefined);
			return;
		}

		const controller = new AbortController();
		const api = new TelegramApi(token);
		this.abortController = controller;
		this.api = api;
		this.updateState('connecting', 'Connecting…', 'Validating Telegram and starting long polling.');
		try {
			this.botUser = await api.getMe(controller.signal);
			// Long polling cannot receive messages while a webhook is registered.
			const webhook = await api.getWebhookInfo(controller.signal);
			if (webhook.url) {
				this.output.appendLine(`[telegram] clearing leftover webhook: ${webhook.url} (pending=${webhook.pending_update_count ?? 0})`);
			}
			await api.deleteWebhook(false, controller.signal);
			try {
				await api.deleteCommands(controller.signal);
				const applied = await api.setCommands(controller.signal);
				this.output.appendLine(`[telegram] command menu refreshed: ${applied ? 'ok' : 'Telegram returned false'}`);
			} catch (commandError) {
				// The menu is cosmetic — every command still works when typed, so a
				// failure here must not stop the bot from coming online.
				this.output.appendLine(`[telegram] could not refresh the command menu: ${safeErrorMessage(commandError)}`);
			}
			const offset = Math.max(0, this.context.globalState.get<number>(UPDATE_OFFSET_STATE_KEY, 0));
			const botHandle = this.botUser.username ? `@${this.botUser.username}` : this.botUser.first_name;
			this.updateState('online', `Online ${botHandle}`, 'Long polling is active.');
			this.output.appendLine(`[telegram] online as ${botHandle} (bot id ${this.botUser.id}), update offset ${offset}`);
			// Start polling immediately. Never await model warm-up here: LM consent or
			// provider discovery can hang and would leave the bot "online" with no inbox.
			void this.poll(api, controller);
			void this.warmAiModel();
		} catch (error) {
			if (!controller.signal.aborted) {
				this.output.appendLine(`[telegram] start failed: ${safeErrorMessage(error)}`);
				this.updateState('error', 'Offline · error', safeErrorMessage(error));
			}
		}
	}

	private async warmAiModel(): Promise<void> {
		try {
			const model = await this.ai.ensureModel();
			this.output.appendLine(`[telegram] AI model ready: ${model.vendor}/${model.id}`);
		} catch (modelError) {
			this.output.appendLine(`[telegram] AI model not ready yet: ${safeErrorMessage(modelError)}`);
		}
	}

	public stop(updateState = true): void {
		this.abortController?.abort();
		this.abortController = undefined;
		this.cancellationSource?.cancel();
		this.cancellationSource?.dispose();
		this.cancellationSource = undefined;
		this.api = undefined;
		this.botUser = undefined;
		this.runner.cancel();
		void vscode.commands.executeCommand('setContext', 'batikcode.telegram.busy', false);
		if (updateState) {
			this.updateState('offline', 'Offline', 'Telegram bot stopped.');
			this.output.appendLine('[telegram] stopped');
		}
	}

	public async createPairingCode(): Promise<void> {
		if (!this.api) {
			const action = await vscode.window.showWarningMessage('Start the Telegram bot before pairing a chat.', 'Start Bot');
			if (action === 'Start Bot') {
				await this.start();
			}
			if (!this.api) {
				return;
			}
		}
		const code = randomBytes(24).toString('base64url');
		this.pairingChallenge = { code, expiresAt: Date.now() + PAIRING_TTL_MS };
		const command = `/pair ${code}`;
		await vscode.env.clipboard.writeText(command);
		const botHandle = this.botUser?.username ? `@${this.botUser.username}` : 'your bot';
		void vscode.window.showInformationMessage(
			`Pairing code ready for ${botHandle}. Open a private Telegram chat with ${botHandle}, paste the copied "${command}" command within 10 minutes, then watch the Telegram log for "paired user".`
		);
		this.output.appendLine(`[telegram] one-time pairing challenge created for ${botHandle}; waiting for private /pair (expires in 10 min)`);
	}

	public async manageAllowedChats(): Promise<void> {
		const current = this.allowedUserIds();
		const input = await vscode.window.showInputBox({
			title: 'Allowed Telegram User IDs',
			prompt: 'Only these numeric Telegram user IDs can control BatikCode in a private chat. Separate multiple IDs with commas or spaces.',
			value: current.join(', '),
			ignoreFocusOut: true,
			validateInput: value => validateUserIds(value)
		});
		if (input === undefined) {
			return;
		}
		const ids = parseUserIds(input);
		await this.context.globalState.update(ALLOWED_USERS_STATE_KEY, ids);
		this.refreshState();
		void vscode.window.showInformationMessage(`${ids.length} Telegram user${ids.length === 1 ? '' : 's'} allowed.`);
	}

	public async enableWorkspaceEditing(): Promise<void> {
		if (!vscode.workspace.isTrusted) {
			void vscode.window.showErrorMessage('Trust this workspace before enabling Telegram workspace editing.');
			return;
		}
		const enabled = this.workspaceEditingEnabled();
		if (enabled) {
			const disable = await vscode.window.showWarningMessage(
				'Telegram workspace editing is enabled for paired chats.',
				'Disable Editing'
			);
			if (disable === 'Disable Editing') {
				await this.context.globalState.update(WORKSPACE_EDITING_STATE_KEY, false);
				this.refreshState();
			}
			return;
		}

		const confirmation = await vscode.window.showWarningMessage(
			'Paired Telegram chats will be able to run Codex with workspace-write access in the currently open Git repository. Tasks cannot use danger-full-access, but they can edit or delete files inside the workspace. Enable this only for a private bot and trusted chats.',
			{ modal: true },
			'Enable Workspace Editing'
		);
		if (confirmation !== 'Enable Workspace Editing') {
			return;
		}
		await this.context.globalState.update(WORKSPACE_EDITING_STATE_KEY, true);
		this.refreshState();
		void vscode.window.showInformationMessage('Telegram workspace editing enabled.');
	}

	public cancelTask(): boolean {
		if (this.cancellationSource) {
			this.cancellationSource.cancel();
			this.output.appendLine('[telegram] active agent task cancelled locally');
			return true;
		}
		return false;
	}

	public async openMenu(): Promise<void> {
		const tokenStored = Boolean(await this.context.secrets.get(TOKEN_SECRET_KEY));
		const items = [
			{ label: '$(key) Configure BotFather Token', action: 'token', description: tokenStored ? 'Replace the stored token' : 'Required' },
			{ label: this.api ? '$(debug-stop) Stop Bot' : '$(play) Start Bot', action: this.api ? 'stop' : 'start', description: this.state.label },
			{ label: '$(link) Pair Telegram User', action: 'pair', description: `${this.allowedUserIds().length} allowed` },
			{ label: '$(shield) Manage Allowed Users', action: 'chats', description: 'Numeric user ID allowlist; private chat only' },
			{ label: '$(edit) Telegram Workspace Editing', action: 'editing', description: this.workspaceEditingEnabled() ? 'Enabled' : 'Disabled' },
			{ label: '$(debug-restart) Reset Inbox Cursor', action: 'reset-offset', description: 'If messages never appear in the log' },
			{ label: '$(broadcast) Test Telegram Connectivity', action: 'diag', description: 'DNS + HTTPS from this BatikCode window' },
			...(this.runner.busy ? [{ label: '$(debug-stop) Cancel Coding Task', action: 'cancel', description: 'Task is running' }] : []),
			{ label: '$(output) Show Telegram Log', action: 'log', description: 'Open Output channel (secrets are redacted)' },
			...(tokenStored ? [{ label: '$(trash) Remove Bot Token', action: 'remove', description: 'Stops the bot' }] : [])
		];
		const selected = await vscode.window.showQuickPick(items, { title: 'Telegram Remote Coding' });
		switch (selected?.action) {
			case 'token': await this.configureToken(); break;
			case 'start': await this.start(); break;
			case 'stop': this.stop(); break;
			case 'pair': await this.createPairingCode(); break;
			case 'chats': await this.manageAllowedChats(); break;
			case 'editing': await this.enableWorkspaceEditing(); break;
			case 'reset-offset': await this.resetInboxCursor(); break;
			case 'diag': await this.diagnoseConnectivity(); break;
			case 'cancel': this.cancelTask(); break;
			case 'log': this.showLog(); break;
			case 'remove': await this.removeToken(); break;
		}
	}

	public showLog(): void {
		this.output.show(true);
		// Always leave a breadcrumb so an empty Output panel is not mistaken for a dead logger.
		this.output.appendLine(`[telegram] log opened · bot=${this.state.label} · ${this.state.detail}`);
	}

	/**
	 * Runs network diagnostics from the same extension-host process that polls Telegram.
	 */
	public async diagnoseConnectivity(): Promise<void> {
		this.output.show(true);
		this.output.appendLine('[telegram] connectivity test starting…');
		try {
			const dns = await import('node:dns');
			const records = await dns.promises.lookup('api.telegram.org', { all: true });
			this.output.appendLine(`[telegram] DNS api.telegram.org => ${records.map(r => `${r.address} (v${r.family})`).join(', ')}`);
		} catch (error) {
			this.output.appendLine(`[telegram] DNS failed: ${safeErrorMessage(error)}`);
		}

		const token = await this.context.secrets.get(TOKEN_SECRET_KEY);
		if (!token) {
			this.output.appendLine('[telegram] no bot token stored; testing public endpoint only');
		}
		try {
			const api = token ? new TelegramApi(token) : new TelegramApi('0:invalid');
			if (token) {
				const me = await api.getMe();
				this.output.appendLine(`[telegram] getMe OK as @${me.username ?? me.first_name} (id ${me.id})`);
				const webhook = await api.getWebhookInfo();
				this.output.appendLine(`[telegram] webhook url=${webhook.url || '(none)'} pending=${webhook.pending_update_count ?? 0}`);
				void vscode.window.showInformationMessage(`Telegram connectivity OK (@${me.username ?? me.first_name}). See log for DNS details.`);
			} else {
				// Exercise HTTPS path without a token by hitting getMe and accepting 401/404-style API errors as "reachable".
				try {
					await api.getMe();
					this.output.appendLine('[telegram] unexpected success without token');
				} catch (error) {
					const message = safeErrorMessage(error);
					if (/unauthorized|not found|http 401|http 404|invalid/i.test(message)) {
						this.output.appendLine(`[telegram] HTTPS reachable (API rejected dummy token as expected): ${message}`);
						void vscode.window.showInformationMessage('Telegram HTTPS reachable from BatikCode. Configure a bot token next.');
					} else {
						this.output.appendLine(`[telegram] HTTPS failed: ${message}`);
						void vscode.window.showErrorMessage(`Telegram HTTPS failed from BatikCode: ${message}`);
					}
				}
			}
		} catch (error) {
			const message = safeErrorMessage(error);
			this.output.appendLine(`[telegram] connectivity test failed: ${message}`);
			void vscode.window.showErrorMessage(`Telegram connectivity failed: ${message}`);
		}
	}

	/**
	 * Clears the persisted Telegram update offset and restarts polling.
	 * Use when the bot is "online" but inbound messages never appear in the log.
	 */
	public async resetInboxCursor(): Promise<void> {
		await this.context.globalState.update(UPDATE_OFFSET_STATE_KEY, 0);
		this.output.appendLine('[telegram] update offset reset to 0');
		if (this.api) {
			try {
				await this.api.deleteWebhook(true);
				this.output.appendLine('[telegram] webhook cleared (drop_pending_updates=true)');
			} catch (error) {
				this.output.appendLine(`[telegram] webhook clear failed: ${safeErrorMessage(error)}`);
			}
			await this.start();
			void vscode.window.showInformationMessage('Telegram inbox cursor reset. Send /start to the bot again.');
		} else {
			void vscode.window.showInformationMessage('Telegram inbox cursor reset. Start the bot, then send /start.');
		}
	}

	public dispose(): void {
		this.disposed = true;
		this.stop(false);
		this.ai.dispose();
		this.stateEmitter.dispose();
	}

	private async poll(api: TelegramApi, controller: AbortController): Promise<void> {
		let offset = Math.max(0, this.context.globalState.get<number>(UPDATE_OFFSET_STATE_KEY, 0));
		let retryDelayMs = 1_000;
		let emptyPolls = 0;
		this.output.appendLine(`[telegram] poll loop started at offset ${offset}`);

		const leaderInterval = setInterval(async () => {
			if (!controller.signal.aborted) {
				const lock = this.context.globalState.get<{ id: string; time: number }>('batikcode.telegram.leader');
				if (lock?.id === this.instanceId) {
					await this.context.globalState.update('batikcode.telegram.leader', { id: this.instanceId, time: Date.now() });
				}
			}
		}, 10000);

		while (!controller.signal.aborted && !this.disposed && this.api === api) {
			try {
				const lock = this.context.globalState.get<{ id: string; time: number }>('batikcode.telegram.leader');
				const now = Date.now();
				let isLeader = false;
				if (!lock || lock.id === this.instanceId || now - lock.time > 15000) {
					await this.context.globalState.update('batikcode.telegram.leader', { id: this.instanceId, time: now });
					isLeader = true;
				}

				if (!isLeader) {
					if (!this.runner.busy) {
						this.updateState('busy', 'Standby', 'Another BatikCode window is running this Telegram bot.');
					}
					await abortableDelay(10000, controller.signal);
					continue;
				}

				const updates = await api.getUpdates(offset, controller.signal);
				retryDelayMs = 1_000;
				if (!this.runner.busy) {
					const handle = this.botUser?.username ? `@${this.botUser.username}` : (this.botUser?.first_name ?? 'bot');
					this.updateState('online', `Online ${handle}`, 'Long polling is active.');
				}
				if (updates.length === 0) {
					emptyPolls++;
					// Heartbeat so a silent inbox is distinguishable from a dead poll loop.
					if (emptyPolls === 1 || emptyPolls % 12 === 0) {
						this.output.appendLine(`[telegram] poll ok (no new messages), offset ${offset}, emptyCycles=${emptyPolls}`);
					}
					continue;
				}
				emptyPolls = 0;
				this.output.appendLine(`[telegram] received ${updates.length} update(s) at offset ${offset}`);
				for (const update of updates) {
					offset = Math.max(offset, update.update_id + 1);
					// A remote coding command must not be replayed after a restart.
					// Confirm receipt before execution; dropping a command on a crash is
					// safer than applying the same workspace edit twice.
					await this.context.globalState.update(UPDATE_OFFSET_STATE_KEY, offset);
					await this.handleUpdate(api, update);
				}
			} catch (error) {
				if (controller.signal.aborted) {
					this.output.appendLine('[telegram] poll loop aborted');
					break;
				}
				const message = safeErrorMessage(error);
				this.output.appendLine(`[telegram] polling error: ${message}`);
				if (error instanceof TelegramApiError && error.telegramErrorCode === 409) {
					this.output.appendLine('[telegram] 409 conflict: another instance took over. Stepping down.');
					const lock = this.context.globalState.get<{ id: string; time: number }>('batikcode.telegram.leader');
					if (lock?.id === this.instanceId) {
						await this.context.globalState.update('batikcode.telegram.leader', undefined);
					}
					await abortableDelay(5000, controller.signal);
					continue;
				}
				// Transient network blips are common on long-poll; keep retrying with backoff.
				const handle = this.botUser?.username ? `@${this.botUser.username}` : (this.botUser?.first_name ?? 'bot');
				this.updateState('error', `Reconnecting ${handle}`, summarizeNetworkIssue(message));
				await abortableDelay(retryDelayMs, controller.signal);
				retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
			}
		}
		clearInterval(leaderInterval);
		this.output.appendLine('[telegram] poll loop exited');
	}

	private async handleUpdate(api: TelegramApi, update: TelegramUpdate): Promise<void> {
		const message = update.message;
		if (!message?.text) {
			this.output.appendLine(`[telegram] ignoring update ${update.update_id} without text message`);
			return;
		}
		const chatId = String(message.chat.id);
		const userId = message.from ? String(message.from.id) : undefined;
		const preview = message.text.replace(/\s+/g, ' ').slice(0, 80);
		this.output.appendLine(`[telegram] inbound from user ${userId ?? 'unknown'} chat ${chatId} (${message.chat.type}): ${preview}`);
		const parsed = parseCommand(message.text);

		// Public commands — available to everyone, even unauthorized users
		if (parsed) {
			if (parsed.command === 'id') {
				await this.safeSend(api, chatId, userId ? `Your Telegram user ID: ${userId}` : 'Telegram did not include a sender user ID.');
				return;
			}
			if (parsed.command === 'pair') {
				await this.handlePair(api, message, parsed.argument);
				return;
			}
			if (parsed.command === 'start') {
				const isPaired = userId ? this.allowedUserIds().includes(userId) : false;
				await this.safeSend(api, chatId, isPaired ? welcomeBackText() : welcomeText());
				return;
			}
			if (parsed.command === 'help') {
				await this.safeSend(api, chatId, helpText());
				return;
			}
		}

		// Authorized commands — require a paired user in a private chat
		if (!isAuthorizedTelegramUser(message.chat.type, userId, this.allowedUserIds())) {
			this.output.appendLine(`[telegram] rejected unauthorized user ${userId ?? 'unknown'} in ${message.chat.type} chat`);
			await this.safeSend(api, chatId, [
				// allow-any-unicode-next-line
				'❌ You are not authorized to control this BatikCode instance.',
				'',
				'To pair, generate a pairing code inside BatikCode:',
				'  Remote Explorer → Telegram Remote Coding → Pair Telegram User',
				'',
				'Then send /pair &lt;your-code&gt; to this bot in a private chat.',
				'Use /start to see the full pairing guide.'
			].join('\n'));
			return;
		}

		if (parsed) {
			switch (parsed.command) {
				case 'status':
					await this.safeSend(api, chatId, await this.statusText());
					break;
				case 'diff':
					await this.safeSend(api, chatId, await this.gitSummary(), false);
					break;
				case 'code':
					await this.handleCode(api, chatId, parsed.argument);
					break;
				case 'cancel':
					await this.safeSend(api, chatId, this.cancelTask() ? 'Cancelling the active coding task.' : 'No coding task is running.');
					break;
				case 'new':
				case 'clear':
					this.ai.clearHistory(chatId);
					// allow-any-unicode-next-line
					await this.safeSend(api, chatId, '🧹 Conversation history cleared. Starting fresh!');
					break;
				case 'models':
					// Split: with every provider connected the catalogue runs to
					// hundreds of entries, well past Telegram's 4096-character
					// message limit, and a single send would simply be rejected.
					await this.sendChunks(api, chatId, await this.ai.listAvailableModels());
					break;
				case 'model':
					await this.safeSend(api, chatId, await this.handleModelSwitch(parsed.argument), false);
					break;
				default:
					await this.safeSend(api, chatId, helpText());
			}
		} else {
			// Non-command text → route to AI chat
			await this.handleAIChat(api, chatId, message.text);
		}
	}

	private async handlePair(api: TelegramApi, message: TelegramMessage, argument: string): Promise<void> {
		const chatId = String(message.chat.id);
		const userId = message.from ? String(message.from.id) : undefined;
		const verdict = evaluatePairing(message.chat.type, userId, this.pairingChallenge, Date.now(), argument);
		if (!verdict.ok) {
			switch (verdict.reason) {
				case 'not-private-chat':
					this.output.appendLine(`[telegram] pair rejected: chat type ${message.chat.type}, user ${userId ?? 'missing'}`);
					await this.safeSend(api, chatId, 'Pairing is allowed only in a private chat with this bot.');
					break;
				case 'no-challenge':
					this.output.appendLine(`[telegram] pair rejected for user ${userId}: no active pairing challenge in BatikCode`);
					await this.safeSend(api, chatId, 'No active pairing code in BatikCode. Generate a new code: Remote Explorer → Telegram → Pair Telegram User.');
					break;
				case 'expired':
					this.output.appendLine(`[telegram] pair rejected for user ${userId}: pairing code expired`);
					await this.safeSend(api, chatId, 'Pairing code expired. Generate a new code inside BatikCode and try again.');
					break;
				case 'code-mismatch':
					this.output.appendLine(`[telegram] pair rejected for user ${userId}: pairing code mismatch`);
					await this.safeSend(api, chatId, 'Pairing code is invalid. Copy the latest code from BatikCode and send it in this private chat.');
					break;
			}
			return;
		}
		const ids = [...new Set([...this.allowedUserIds(), userId!])];
		await this.context.globalState.update(ALLOWED_USERS_STATE_KEY, ids);
		this.pairingChallenge = undefined;
		this.refreshState();
		this.output.appendLine(`[telegram] paired user ${userId}`);
		await this.safeSend(api, chatId, [
			`<b>Paired with BatikCode!</b>`,
			'',
			`You can now send plain text to chat with the BatikCode AI model, or use /status and /code.`,
			'',
			`<b>Next step (optional workspace edits):</b>`,
			`1. Open BatikCode`,
			`2. Remote Explorer → Telegram Remote Coding`,
			`3. Enable Workspace Editing`,
			'',
			`Then run: /code &lt;description of the task&gt;`,
			'',
			`Use /help to see all available commands.`
		].join('\n'));
		void vscode.window.showInformationMessage(`Telegram user ${userId} paired with BatikCode.`);
	}

	private async handleCode(api: TelegramApi, chatId: string, argument: string): Promise<void> {
		const prompt = argument.trim();
		if (!prompt) {
			await this.safeSend(api, chatId, 'Usage: /code &lt;coding task&gt;');
			return;
		}
		if (prompt.length > MAX_PROMPT_LENGTH) {
			await this.safeSend(api, chatId, `Task is too long. Maximum ${MAX_PROMPT_LENGTH} characters.`);
			return;
		}
		if (!this.workspaceEditingEnabled()) {
			await this.safeSend(api, chatId, 'Workspace editing is disabled. Enable it locally from BatikCode → Telegram Remote Coding.');
			return;
		}
		if (!vscode.workspace.isTrusted) {
			await this.safeSend(api, chatId, 'The current BatikCode workspace is not trusted.');
			return;
		}
		const workspace = vscode.workspace.workspaceFolders?.[0];
		if (!workspace || workspace.uri.scheme !== 'file') {
			await this.safeSend(api, chatId, 'Open a local Git workspace in BatikCode before using /code.');
			return;
		}
		if (this.runner.busy) {
			await this.safeSend(api, chatId, 'Another coding task is already running. Use /cancel first.');
			return;
		}

		const timeoutMinutes = vscode.workspace.getConfiguration('batikcode.telegram').get<number>('taskTimeoutMinutes', 10);
		const boundedTimeout = Math.max(1, Math.min(120, timeoutMinutes)) * 60_000;

		this.output.appendLine(`[telegram] agent task started for chat ${chatId} in workspace ${workspace.name}`);
		this.updateState('busy', 'Online · coding', `Running an agent task for chat ${chatId}.`);
		await vscode.commands.executeCommand('setContext', 'batikcode.telegram.busy', true);
		void vscode.window.showInformationMessage(`Telegram coding task received for ${workspace.name}.`);
		// allow-any-unicode-next-line
		await this.safeSend(api, chatId, `✅ Agent task started in "${workspace.name}". I'll read files, make changes, and report back.\n\nUse /cancel to stop.`);

		// Typing indicator — refresh every 4s (Telegram expires after ~5s).
		void api.sendChatAction(chatId, 'typing');
		const typingTimer = setInterval(() => {
			if (this.runner.busy) {
				void api.sendChatAction(chatId, 'typing');
			}
		}, 4_000);

		// Progress messages every 30s.
		let progressTick = 0;
		const progressInterval = setInterval(async () => {
			progressTick++;
			if (!this.runner.busy) {
				return;
			}
			if (progressTick === 1) {
				// allow-any-unicode-next-line
				await this.safeSend(api, chatId, '⏳ Working… reading files and planning changes.');
			} else {
				const minutes = Math.ceil(progressTick * 30 / 60);
				// allow-any-unicode-next-line
				await this.safeSend(api, chatId, `⏳ Still working (${minutes} min elapsed)…`);
			}
		}, 30_000);

		// Accumulate streaming output and send in chunks to Telegram.
		let accumulated = '';
		let lastSendTime = Date.now();
		const sendAccumulated = async (force = false) => {
			if (!accumulated.trim()) {
				return;
			}
			const now = Date.now();
			if (!force && now - lastSendTime < 2000) {
				return;
			}
			const toSend = accumulated;
			accumulated = '';
			lastSendTime = now;
			await this.sendChunks(api, chatId, toSend);
		};

		// Wire timeout: cancel the token when time runs out.
		const cancellationSource = new vscode.CancellationTokenSource();
		this.cancellationSource = cancellationSource;
		const timeoutTimer = setTimeout(() => {
			cancellationSource.cancel();
		}, boundedTimeout);

		try {
			await this.runner.run(
				workspace.uri.fsPath,
				prompt,
				boundedTimeout,
				{
					onTextChunk: (chunk: string) => {
						accumulated += chunk;
						void sendAccumulated(false);
					},
					onToolStart: (_name: string) => {
						this.output.appendLine(`[telegram] agent tool: ${_name}`);
					},
					onToolEnd: (_name: string) => {
						// no-op
					}
				},
				cancellationSource.token
			);

			clearTimeout(timeoutTimer);
			clearInterval(typingTimer);
			clearInterval(progressInterval);

			// Flush remaining accumulated text.
			await sendAccumulated(true);
			// allow-any-unicode-next-line
			await this.safeSend(api, chatId, '✅ Agent task completed.');

			this.output.appendLine(`[telegram] agent task completed successfully`);
		} catch (error) {
			clearTimeout(timeoutTimer);
			clearInterval(typingTimer);
			clearInterval(progressInterval);

			// Flush any partial output before reporting the error.
			await sendAccumulated(true);

			const message = safeErrorMessage(error);
			// Log the stack and the underlying cause: the chat reply is size-capped,
			// so the Output channel is the only place the full failure survives.
			this.output.appendLine(`[telegram] agent task failed: ${message.slice(0, 500)}`);
			if (error instanceof Error && error.stack) {
				this.output.appendLine(error.stack);
			}
			const cause = error instanceof Error ? error.cause : undefined;
			if (cause) {
				this.output.appendLine(`[telegram] caused by: ${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}`);
			}
			// allow-any-unicode-next-line
			await this.sendChunks(api, chatId, `❌ ${message}`);
		} finally {
			clearTimeout(timeoutTimer);
			clearInterval(typingTimer);
			clearInterval(progressInterval);
			this.cancellationSource?.dispose();
			this.cancellationSource = undefined;
			await vscode.commands.executeCommand('setContext', 'batikcode.telegram.busy', false);
			if (this.api) {
				this.updateState('online', `Online @${this.botUser?.username ?? this.botUser?.first_name ?? 'bot'}`, 'Long polling is active.');
			} else {
				this.updateState('offline', 'Offline', 'Telegram bot stopped.');
			}
		}
	}

	private async handleModelSwitch(argument: string): Promise<string> {
		const arg = argument.trim();
		if (!arg) {
			return await this.ai.listAvailableModels();
		}
		const normalizedArg = normalizeModelSelection(arg);
		if (normalizedArg === 'auto') {
			return await this.ai.clearModelPreference();
		}
		const index = parseInt(arg, 10);
		if (!Number.isNaN(index) && index >= 1) {
			try {
				this.ai.invalidateModel();
				return await this.ai.selectModelByIndex(index);
			} catch (error) {
				return `Failed to switch model: ${safeErrorMessage(error)}`;
			}
		}
		return 'Usage: /model <number> or /model auto\\nSend /models to see the numbered list.';
	}

	private async handleAIChat(api: TelegramApi, chatId: string, text: string): Promise<void> {
		this.output.appendLine(`[telegram] AI chat from ${chatId}: "${text.slice(0, 80)}…"`);

		// Show typing indicator so the user knows the bot is processing.
		void api.sendChatAction(chatId, 'typing');

		const typingTimer = setInterval(() => {
			void api.sendChatAction(chatId, 'typing');
		}, 4_000);

		try {
			const response = await this.ai.chat(chatId, text);

			const responseText = response.trim();
			if (responseText) {
				// AI output is markdown/plain — never HTML-parse it.
				await this.sendChunks(api, chatId, responseText);
			} else {
				await this.safeSend(api, chatId, 'BatikBot returned an empty response.');
			}
		} catch (error) {
			const message = safeErrorMessage(error);
			this.output.appendLine(`[telegram] AI chat error: ${message.slice(0, 500)}`);
			this.ai.invalidateModel();
			if (/no ai model is available/i.test(message)) {
				await this.safeSend(api, chatId, [
					'No AI model is available in BatikCode.',
					'',
					'1. Open BatikCode → Account & AI Provider Hub',
					'2. Add an API key / local provider and ensure a model is listed',
					'3. Reload the window if needed',
					'4. Send another message here (or /status to verify the model)'
				].join('\n'));
			} else {
				await this.safeSend(api, chatId, `Error from BatikCode AI:\n${message}`);
			}
		} finally {
			clearInterval(typingTimer);
		}
	}

	private async gitSummary(): Promise<string> {
		const workspace = vscode.workspace.workspaceFolders?.[0];
		if (!workspace || workspace.uri.scheme !== 'file') {
			return 'No local workspace is open.';
		}
		try {
			const [{ stdout: status }, { stdout: diff }] = await Promise.all([
				execFileAsync('git', ['status', '--short'], { cwd: workspace.uri.fsPath, timeout: 10_000 }),
				execFileAsync('git', ['diff', '--stat'], { cwd: workspace.uri.fsPath, timeout: 10_000 })
			]);
			return [
				`Workspace: ${workspace.name}`,
				'',
				'Git status:',
				status.trim() || 'Clean',
				'',
				'Diff summary:',
				diff.trim() || 'No unstaged diff'
			].join('\n').slice(0, 3900);
		} catch (error) {
			return `Could not read Git status: ${safeErrorMessage(error)}`;
		}
	}

	private async statusText(): Promise<string> {
		const workspace = vscode.workspace.workspaceFolders?.[0];
		const workspaceName = workspace?.name ?? 'none';
		const gitBranch = workspace ? await this.gitBranch(workspace.uri.fsPath) : undefined;
		let modelLine = 'AI model: not selected yet';
		try {
			const model = await this.ai.ensureModel();
			modelLine = `AI model: ${escapeHtml(model.vendor)}/${escapeHtml(model.family)} (${escapeHtml(model.name ?? model.id)})`;
		} catch (error) {
			modelLine = `AI model: unavailable (${escapeHtml(safeErrorMessage(error))})`;
		}
		return [
			`<b>BatikCode Status</b>`,
			'',
			`Bot: ${escapeHtml(this.state.label)}`,
			`Workspace: ${escapeHtml(workspaceName)}${gitBranch ? ` (${escapeHtml(gitBranch)})` : ''}`,
			modelLine,
			`Workspace editing: ${this.workspaceEditingEnabled() ? 'enabled' : 'disabled'}`,
			`Coding task: ${this.runner.busy ? 'running' : 'idle'}`,
			`Allowed users: ${this.allowedUserIds().length}`,
			this.runner.busy ? '' : 'Tip: send plain text to chat with the BatikCode model, or /code &lt;task&gt; to edit the workspace.'
		].filter(Boolean).join('\n');
	}

	private async gitBranch(workspacePath: string): Promise<string | undefined> {
		try {
			const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: workspacePath, timeout: 5000 });
			return stdout.trim() || undefined;
		} catch {
			return undefined;
		}
	}

	private async sendChunks(api: TelegramApi, chatId: string, content: string): Promise<void> {
		const allChunks = chunkText(content, 3500);
		const chunks = allChunks.slice(0, 12);
		for (const chunk of chunks) {
			// Dynamic/model output is plain text so markdown/code cannot break HTML parse_mode.
			await this.safeSend(api, chatId, chunk, false);
		}
		if (allChunks.length > chunks.length) {
			await this.safeSend(api, chatId, '[Additional output omitted by BatikCode.]', false);
		}
	}

	private async safeSend(api: TelegramApi, chatId: string, text: string, html = true): Promise<void> {
		try {
			await api.sendMessage(chatId, text, html ? { parseMode: 'HTML' } : undefined);
		} catch (error) {
			const message = safeErrorMessage(error);
			this.output.appendLine(`[telegram] send failed for chat ${chatId}: ${message}`);
			// If curated HTML is rejected, retry once as plain text so the user still gets a reply.
			if (html) {
				try {
					await api.sendMessage(chatId, stripHtml(text));
				} catch (fallbackError) {
					this.output.appendLine(`[telegram] plain fallback send failed for chat ${chatId}: ${safeErrorMessage(fallbackError)}`);
				}
			}
		}
	}

	private allowedUserIds(): readonly string[] {
		return this.context.globalState.get<readonly string[]>(ALLOWED_USERS_STATE_KEY, []);
	}

	private workspaceEditingEnabled(): boolean {
		return this.context.globalState.get<boolean>(WORKSPACE_EDITING_STATE_KEY, false);
	}

	private async resetAuthorization(): Promise<void> {
		this.pairingChallenge = undefined;
		await Promise.all([
			this.context.globalState.update(ALLOWED_USERS_STATE_KEY, []),
			this.context.globalState.update(LEGACY_ALLOWED_CHATS_STATE_KEY, undefined),
			this.context.globalState.update(WORKSPACE_EDITING_STATE_KEY, false),
			this.context.globalState.update(UPDATE_OFFSET_STATE_KEY, 0)
		]);
		this.refreshState();
	}

	private createState(connection: TelegramConnectionState, label: string, detail: string): TelegramBotState {
		return {
			connection,
			label,
			detail,
			username: this.botUser?.username,
			allowedUserCount: this.allowedUserIds().length,
			workspaceEditingEnabled: this.workspaceEditingEnabled(),
			taskRunning: this.runner.busy
		};
	}

	private updateState(connection: TelegramConnectionState, label: string, detail: string): void {
		this.currentState = {
			connection,
			label,
			detail,
			username: this.botUser?.username,
			allowedUserCount: this.allowedUserIds().length,
			workspaceEditingEnabled: this.workspaceEditingEnabled(),
			taskRunning: this.runner.busy
		};
		this.stateEmitter.fire(this.currentState);
	}

	private refreshState(): void {
		this.updateState(this.currentState.connection, this.currentState.label, this.currentState.detail);
	}
}

function validateBotToken(value: string): string | undefined {
	return /^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(value.trim())
		? undefined
		: 'Enter a valid BotFather token.';
}

function validateUserIds(value: string): string | undefined {
	return value.trim() && parseUserIds(value).length === 0
		? 'Use numeric Telegram user IDs separated by commas or spaces.'
		: undefined;
}

function parseCommand(value: string): { command: string; argument: string } | undefined {
	const match = /^\/([a-zA-Z]+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(value.trim());
	return match ? { command: match[1].toLowerCase(), argument: match[2] ?? '' } : undefined;
}

function helpText(): string {
	return [
		'<b>BatikCode Remote Coding — Commands</b>',
		'',
		// allow-any-unicode-next-line
		'💬 <b>Natural Chat (no / needed!)</b>',
		'Just send any text to chat with the active AI model.',
		'The bot understands natural language about your code.',
		'',
		'<b>Getting Started</b>',
		'/start — Welcome and pairing guide',
		'/pair &lt;code&gt; — Pair with BatikCode',
		'/id — Show your Telegram user ID',
		'',
		'<b>Coding</b>',
		'/code &lt;task&gt; — Run a coding task (requires pairing + workspace editing)',
		'/cancel — Cancel the active coding task',
		'/diff — Show Git status and diff summary',
		'',
		'<b>Chat</b>',
		'/new — Clear conversation history',
		'/clear — Same as /new',
		'/models — List available AI models',
		'/model &lt;number&gt; — Switch Telegram to a specific model',
		'/model auto — Return Telegram to automatic model selection',
		'',
		'<b>Info</b>',
		'/status — Bot and workspace status',
		'/help — Show this help',
		'',
		'<b>Tips:</b>',
		'• Ask questions naturally: "what branch am I on?" or "show me the git log"',
		'• For actual file editing, use: /code &lt;description&gt;',
		'• Use /models to inspect available models and /model auto to return to auto mode.',
		'• Use /new to reset the conversation when changing topics.'
	].join('\n');
}

function welcomeText(): string {
	return [
		'<b>Welcome to BatikCode Remote Coding!</b>',
		'',
		'This bot lets you control BatikCode remotely via Telegram and chat with the same AI models configured in BatikCode Provider Hub.',
		'',
		'<b>Natural AI Chat</b>',
		'Once paired, send any message and BatikBot answers using a BatikCode model — no slash command needed for questions.',
		'',
		'<b>To get started:</b>',
		'',
		'1. <b>Get your User ID</b> — send /id',
		'2. <b>Pair with BatikCode</b> — Remote Explorer → Telegram Remote Coding → Pair Telegram User, then send <code>/pair &lt;code&gt;</code>',
		'3. <b>Configure AI</b> — Account &amp; AI Provider Hub must expose at least one model',
		'4. <b>Optional workspace edits</b> — enable Workspace Editing, then use /code &lt;task&gt;',
		'',
		'Send /help anytime to see all commands.'
	].join('\n');
}

function welcomeBackText(): string {
	return [
		// allow-any-unicode-next-line
		'<b>👋 Welcome back!</b>',
		'',
		'You are already paired with BatikCode. Here\'s what you can do:',
		'',
		// allow-any-unicode-next-line
		'💬 <b>Natural Chat</b>',
		'Just send any message and I\'ll respond using the active AI model.',
		'No need for / commands for casual questions!',
		'',
		// allow-any-unicode-next-line
		'🤖 <b>Model Control</b>',
		'• /models — List available AI models',
		'• /model &lt;number&gt; — Pick a model from Telegram',
		'• /model auto — Return to automatic selection',
		'',
		'• /status — Check workspace and bot status',
		'• /code &lt;task&gt; — Run a remote coding task',
		'• /diff — See Git changes',
		'• /new — Clear conversation history',
		'',
		'<b>Need workspace editing enabled?</b>',
		'Ask the BatikCode workspace owner to enable it in:',
		'Remote Explorer → Telegram Remote Coding → Workspace Editing',
		'',
		'Send /help for all commands.'
	].join('\n');
}

function chunkText(value: string, size: number): string[] {
	const chunks: string[] = [];
	for (let offset = 0; offset < value.length; offset += size) {
		chunks.push(value.slice(offset, offset + size));
	}
	return chunks.length ? chunks : ['(empty result)'];
}

function safeErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.name === 'AbortError' ? 'Operation cancelled.' : error.message;
	}
	return String(error);
}

function summarizeNetworkIssue(message: string): string {
	const lower = message.toLowerCase();
	if (lower.includes('enotfound') || lower.includes('getaddrinfo')) {
		return 'DNS failed for api.telegram.org. Check internet/DNS.';
	}
	if (lower.includes('cert') || lower.includes('ssl') || lower.includes('tls')) {
		return 'TLS/proxy interception blocked api.telegram.org.';
	}
	if (lower.includes('econnreset') || lower.includes('econnrefused') || lower.includes('etimedout') || lower.includes('fetch failed') || lower.includes('network error') || lower.includes('timed out')) {
		return 'Network blip to api.telegram.org. Retrying long poll…';
	}
	return message.slice(0, 160);
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function stripHtml(value: string): string {
	return value
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/p>/gi, '\n')
		.replace(/<[^>]+>/g, '')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&')
		.replace(/&quot;/g, '"');
}

async function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) {
		return;
	}
	await new Promise<void>(resolve => {
		const timer = setTimeout(done, delayMs);
		const abort = () => done();
		function done() {
			clearTimeout(timer);
			signal.removeEventListener('abort', abort);
			resolve();
		}
		signal.addEventListener('abort', abort, { once: true });
	});
}
