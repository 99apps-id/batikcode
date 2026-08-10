/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile, spawn } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import { access, readFile } from 'fs/promises';
import { homedir } from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { createCliInvocation, resolveCliWorkingDirectory } from './cliProcess';

export type OAuthBootstrapId = 'github-cli' | 'codex-cli' | 'gemini-cli' | 'kiro-client' | 'antigravity';
export type CloudCodeOAuthId = Extract<OAuthBootstrapId, 'gemini-cli' | 'antigravity'>;

export interface OAuthBootstrapStatus {
	readonly available: boolean;
	readonly connected?: boolean;
	readonly label: string;
	readonly detail: string;
}

interface OAuthBootstrapProfile {
	readonly id: OAuthBootstrapId;
	readonly displayName: string;
	readonly executable: string;
	readonly loginCommand: string;
	readonly statusArgs?: readonly string[];
	readonly connectedPattern?: RegExp;
	readonly testCommand?: string;
	readonly testUsesQuota?: boolean;
	readonly signOutCommand?: string;
	/** npm package name for auto-install. Undefined = cannot auto-install. */
	readonly npmPackage?: string;
	/** @internal path to the bundled CLI binary (shipped with BatikCode installer) */
	readonly bundledBinary?: string;
	/** Built-in OAuth2 PKCE flow (no CLI binary needed). Used by Antigravity. */
	readonly oauthFlow?: OAuthFlowConfig;
}

interface OAuthFlowConfig {
	readonly authorizeUrl: string;
	readonly tokenUrl: string;
	readonly clientId: string;
	/**
	 * Google issues these CLI clients as "installed app" confidential clients, so
	 * its token endpoint rejects the exchange with `invalid_client` unless the
	 * published secret is sent alongside PKCE. Not a credential to protect: it
	 * ships inside the corresponding public CLI.
	 */
	readonly clientSecret?: string;
	readonly scope: string;
	readonly redirectUri: string;
	readonly loopbackPort: number;
	readonly loopbackPath: string;
	readonly extraParams?: Record<string, string>;
	/** If true, user pastes a short device code instead of a redirect URL. Gemini CLI uses this. */
	readonly manualCodeFlow?: boolean;
}

interface StoredOAuthTokens {
	readonly accessToken: string;
	readonly refreshToken?: string;
	readonly expiresAt: number;
}

/** Refresh once the access token is within this window of expiring. */
const TOKEN_REFRESH_LEAD_MS = 5 * 60_000;

/**
 * How often connected CLI providers are re-probed in the background. Each probe
 * spawns child processes, so this stays coarse; sign-in and sign-out refresh
 * eagerly rather than waiting for the next tick.
 */
const MODEL_POLL_INTERVAL_MS = 5 * 60_000;

/** How long a CLI probe result is reused before being recomputed. */
const PROBE_CACHE_TTL_MS = 30_000;

const PROFILES: Readonly<Record<OAuthBootstrapId, OAuthBootstrapProfile>> = {
	'github-cli': {
		id: 'github-cli',
		displayName: 'GitHub',
		executable: 'gh',
		loginCommand: 'gh auth login --hostname github.com --web --git-protocol https',
		statusArgs: ['auth', 'status', '--hostname', 'github.com'],
		testCommand: 'gh auth status --hostname github.com',
		signOutCommand: 'gh auth logout --hostname github.com'
	},
	'codex-cli': {
		id: 'codex-cli',
		displayName: 'Codex',
		executable: 'codex',
		loginCommand: 'codex login',
		statusArgs: ['login', 'status'],
		connectedPattern: /logged in/i,
		testCommand: 'codex login status',
		signOutCommand: 'codex logout',
		npmPackage: '@openai/codex'
	},
	'gemini-cli': {
		id: 'gemini-cli',
		displayName: 'Gemini CLI',
		executable: 'gemini',
		loginCommand: '',
		statusArgs: undefined,
		connectedPattern: undefined,
		testCommand: undefined,
		testUsesQuota: false,
		npmPackage: '@google/gemini-cli',
		// Standard Google OAuth2 with PKCE + manual code paste.
		// Redirect URI is codeassist.google.com/authcode — after sign-in,
		// the browser redirects there and shows a short auth code (4/xxxxx)
		// that the user copies and pastes into BatikCode.
		oauthFlow: {
			authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
			tokenUrl: 'https://oauth2.googleapis.com/token',
			clientId: '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com',
			clientSecret: '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',
			scope: 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile',
			redirectUri: 'https://codeassist.google.com/authcode',
			loopbackPort: 51121,
			loopbackPath: '/oauth2callback',
			extraParams: { access_type: 'offline', prompt: 'consent' },
			manualCodeFlow: true
		}
	},
	'kiro-client': {
		id: 'kiro-client',
		displayName: 'AWS Kiro',
		executable: 'kiro',
		loginCommand: 'kiro .'
	},
	'antigravity': {
		id: 'antigravity',
		displayName: 'Antigravity (Google)',
		executable: 'gemini',
		loginCommand: '',
		statusArgs: undefined,
		connectedPattern: undefined,
		testCommand: undefined,
		testUsesQuota: false,
		npmPackage: '@google/gemini-cli',
		oauthFlow: {
			authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
			tokenUrl: 'https://oauth2.googleapis.com/token',
			clientId: '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',
			clientSecret: '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',
			scope: 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/cclog https://www.googleapis.com/auth/experimentsandconfigs',
			redirectUri: 'http://127.0.0.1:51121/oauth2callback',
			loopbackPort: 51121,
			loopbackPath: '/oauth2callback',
			extraParams: { access_type: 'offline', prompt: 'consent' }
		}
	}
};

export class OAuthCliBootstrap {
	private readonly output = vscode.window.createOutputChannel('BatikCode Provider Bootstrap', { log: true });
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	private readonly refreshTimer: ReturnType<typeof setInterval>;
	private lastModelFingerprint: string | undefined;
	private refreshInFlight = false;
	/** In-flight token refreshes, keyed by provider, so callers share one exchange. */
	private readonly refreshInFlightById = new Map<OAuthBootstrapId, Promise<StoredOAuthTokens>>();
	/** Cloud Code projects, resolved lazily per OAuth account type. */
	private readonly cloudCodeProjects = new Map<CloudCodeOAuthId, string>();
	private readonly statusCache = new Map<OAuthBootstrapId, { at: number; value: Promise<OAuthBootstrapStatus> }>();
	private readonly chatModelsCache = new Map<OAuthBootstrapId, { at: number; value: Promise<readonly { id: string; name: string }[]> }>();
	public readonly onDidChange = this.changeEmitter.event;

	public constructor(private readonly context: vscode.ExtensionContext) {
		this.refreshTimer = setInterval(() => void this.refreshModelAvailability(), MODEL_POLL_INTERVAL_MS);
		context.subscriptions.push(
			this.output,
			this.changeEmitter,
			{ dispose: () => clearInterval(this.refreshTimer) }
		);
		void this.refreshModelAvailability();
	}

	/**
	 * Probing a CLI provider costs a PATH scan and a child process — `gemini
	 * models` additionally makes a network call. The model picker asks for this
	 * on every render, so answers are cached briefly; {@link refreshModelAvailability}
	 * passes `force` to bypass it after a sign-in.
	 */
	private fromCache<T>(cache: Map<OAuthBootstrapId, { at: number; value: Promise<T> }>, id: OAuthBootstrapId, force: boolean, compute: () => Promise<T>): Promise<T> {
		const entry = cache.get(id);
		if (!force && entry && Date.now() - entry.at < PROBE_CACHE_TTL_MS) {
			return entry.value;
		}
		const value = compute();
		cache.set(id, { at: Date.now(), value });
		// A rejected probe must not be cached as the answer for the next 30s.
		void value.catch(() => cache.delete(id));
		return value;
	}

	public async getStatus(id: OAuthBootstrapId, force = false): Promise<OAuthBootstrapStatus> {
		return this.fromCache(this.statusCache, id, force, () => this.computeStatus(id));
	}

	private async computeStatus(id: OAuthBootstrapId): Promise<OAuthBootstrapStatus> {
		const profile = PROFILES[id];

		// Antigravity + Gemini CLI: built-in OAuth — check stored tokens.
		if (id === 'antigravity' || id === 'gemini-cli') {
			const tokens = await this.getValidTokens(id);
			if (tokens) {
				const expired = tokens.expiresAt < Date.now() + TOKEN_REFRESH_LEAD_MS;
				return {
					available: true,
					connected: !expired,
					label: expired ? 'Sign in required' : 'Connected via OAuth',
					detail: expired
						? 'The OAuth token expired and could not be refreshed. Sign in again.'
						: `Google OAuth token stored${tokens.refreshToken ? ' with automatic refresh' : ' without a refresh token'}.`
				};
			}
			return {
				available: true,
				connected: false,
				label: 'Sign in required',
				detail: 'Sign in with your Google account via OAuth.'
			};
		}

		const executable = await findExecutable(profile.executable);
		if (!executable) {
			return {
				available: false,
				label: 'Client not installed',
				detail: `Install the official ${profile.displayName} client to use its managed OAuth flow.`
			};
		}

		if (!profile.statusArgs) {
			return {
				available: true,
				label: 'Official client available',
				detail: `${profile.displayName} manages its own OAuth tokens and credential storage.`
			};
		}

		const status = await run(executable, profile.statusArgs);
		const connected = status.exitCode === 0 && (!profile.connectedPattern || profile.connectedPattern.test(`${status.stdout}\n${status.stderr}`));
		return connected
			? {
				available: true,
				connected: true,
				label: 'Connected through official client',
				detail: `${profile.displayName} reports an active local session. BatikCode did not read its token.`
			}
			: {
				available: true,
				connected: false,
				label: 'Sign in required',
				detail: `Start the official ${profile.displayName} sign-in flow.`
			};
	}

	public async getChatModels(id: OAuthBootstrapId, force = false): Promise<readonly { id: string; name: string }[]> {
		return this.fromCache(this.chatModelsCache, id, force, () => this.computeChatModels(id, force));
	}

	private async computeChatModels(id: OAuthBootstrapId, force: boolean): Promise<readonly { id: string; name: string }[]> {
		const status = await this.getStatus(id, force);
		if (!status.connected) {
			return [];
		}
		if (id === 'codex-cli') {
			try {
				const raw = JSON.parse(await readFile(path.join(homedir(), '.codex', 'models_cache.json'), 'utf8')) as {
					models?: readonly { slug?: unknown; display_name?: unknown; visibility?: unknown; supported_in_api?: unknown }[];
				};
				const models = (raw.models ?? [])
					.filter(model => typeof model.slug === 'string' && model.visibility !== 'hide' && model.supported_in_api !== false)
					.map(model => ({
						id: model.slug as string,
						name: typeof model.display_name === 'string' ? model.display_name : model.slug as string
					}));
				if (models.length) {
					return models;
				}
			} catch {
				// The official client can still select its own default model.
			}
			return [{ id: 'auto', name: 'Codex (Auto)' }];
		}
		if (id === 'gemini-cli') {
			// Cloud Code's Gemini CLI preset uses OAuth directly, so the model list
			// must not depend on a separate local Gemini CLI installation.
			return [
				{ id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro Preview' },
				{ id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash Preview' },
				{ id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
				{ id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' }
			];
		}
		if (id === 'antigravity') {
			// Antigravity Cloud Code models (from NesaRouter preset).
			return [
				{ id: 'gemini-3-flash', name: 'Gemini 3 Flash' },
				{ id: 'gemini-3-flash-agent', name: 'Gemini 3 Flash Agent' },
				{ id: 'gemini-3.1-pro-low', name: 'Gemini 3.1 Pro Low' },
				{ id: 'gemini-pro-agent', name: 'Gemini Pro Agent' },
				{ id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4 (via Antigravity)' }
			];
		}
		return [];
	}

	/**
	 * Chats through Cloud Code with an OAuth token, refreshing it first when due
	 * and resolving the project the selected provider is entitled to use.
	 */
	public async runCloudCodeChat(
		id: CloudCodeOAuthId,
		model: string,
		contents: readonly CloudCodeTurn[],
		systemInstruction: string | undefined,
		tools: readonly CloudCodeTool[] | undefined,
		toolMode: 'auto' | 'required',
		token: vscode.CancellationToken
	): Promise<CloudCodeReply> {
		const tokens = await this.getValidTokens(id);
		if (!tokens) {
			throw new Error(`${PROFILES[id].displayName} is not connected. Sign in from the Account & AI Provider Hub.`);
		}
		if (tokens.expiresAt < Date.now()) {
			throw new Error(`The ${PROFILES[id].displayName} token expired and could not be refreshed. Sign in again.`);
		}

		let project = this.cloudCodeProjects.get(id);
		if (project === undefined) {
			project = await loadCloudCodeProject(id, tokens.accessToken);
			if (project) {
				this.cloudCodeProjects.set(id, project);
			}
		}
		if (!project) {
			throw new Error(`${PROFILES[id].displayName} needs a Cloud Code project. Reconnect OAuth or use a Google account with Code Assist access.`);
		}

		const controller = new AbortController();
		const cancellation = token.onCancellationRequested(() => controller.abort());
		try {
			return await requestCloudCodeChat(
				id,
				tokens.accessToken,
				project,
				model,
				contents,
				systemInstruction,
				tools,
				toolMode,
				controller.signal
			);
		} finally {
			cancellation.dispose();
		}
	}

	/** Cloud Code providers use {@link runCloudCodeChat}; Codex uses its official CLI. */
	public async runChat(id: 'codex-cli' | 'gemini-cli', model: string, prompt: string, token: vscode.CancellationToken): Promise<string> {
		const profile = PROFILES[id];
		const executable = await findExecutable(profile.executable);
		if (!executable) {
			throw new Error(`${profile.displayName} is not installed or is not available on PATH. Run "${profile.executable}" in a terminal to verify.`);
		}
		const cwd = await resolveWorkingDirectory();
		if (id === 'codex-cli') {
			const args = ['exec', '--ephemeral', '--sandbox', 'read-only', '--skip-git-repo-check', '--color', 'never', '--ignore-rules', '-C', cwd];
			if (model !== 'auto') {
				args.push('--model', model);
			}
			args.push('-');
			try {
				return await runWithRetry(executable, args, prompt, cwd, token);
			} catch (error) {
				if (model !== 'auto' && requiresNewerCodex(error)) {
					this.output.warn(`Codex CLI cannot use ${model}; retrying with --model auto.`);
					void vscode.window.showWarningMessage(
						`${model} requires a newer Codex CLI. BatikCode is using auto model for this request.`,
						'Update Codex CLI'
					).then(action => {
						if (action === 'Update Codex CLI') {
							const terminal = this.createTerminal('Codex Update');
							terminal.show();
							terminal.sendText('codex update', true);
						}
					});
					// Replace the incompatible model with 'auto' instead of
					// removing --model entirely, which would fall back to the
					// (potentially incompatible) config.toml default.
					const fallbackArgs = args.filter((value, index) => value !== '--model' && !(index > 0 && args[index - 1] === '--model'));
					fallbackArgs.push('--model', 'auto');
					return runWithRetry(executable, fallbackArgs, prompt, cwd, token);
				}
				throw error;
			}
		}
		const args = ['--prompt', '', '--output-format', 'text', '--approval-mode', 'plan'];
		if (model !== 'auto') {
			args.push('--model', model);
		}
		// Gemini CLI reads GEMINI_API_KEY from the environment. Pass the
		// router-configured API key so the user does not need the deprecated
		// `gemini auth login` OAuth flow.
		if (id === 'gemini-cli') {
			const geminiKey = await this.getGeminiApiKey();
			if (!geminiKey) {
				throw new Error(
					'Gemini API key is not configured. Open BatikCode → Accounts & AI Providers → Gemini, add an API key, then try again.'
				);
			}
			const prev = process.env.GEMINI_API_KEY;
			try {
				process.env.GEMINI_API_KEY = geminiKey;
				return await runWithRetry(executable, args, prompt, cwd, token);
			} finally {
				if (prev === undefined) {
					delete process.env.GEMINI_API_KEY;
				} else {
					process.env.GEMINI_API_KEY = prev;
				}
			}
		}
		return runWithRetry(executable, args, prompt, cwd, token);
	}

	public async connect(id: OAuthBootstrapId): Promise<void> {
		const profile = PROFILES[id];

		// Gemini CLI + Antigravity: built-in PKCE manual code paste OAuth flow.
		if ((id === 'antigravity' || id === 'gemini-cli') && profile.oauthFlow) {
			await this.connectGoogleOAuth(profile);
			return;
		}

		if (!await this.ensureInstalled(id)) {
			return;
		}

		if (!await this.confirmTemporaryMode(profile.displayName)) {
			return;
		}
		const terminal = this.createTerminal(profile.displayName);
		terminal.show();
		terminal.sendText(profile.loginCommand, true);
	}

	/**
	 * Retrieves the first enabled Gemini API key from the router account pool.
	 */
	private async getGeminiApiKey(): Promise<string | undefined> {
		try {
			// Read the serialized account list from the secrets store directly
			// to avoid circular dependency with ProviderAccountPool.
			const accountsJson = await this.context.secrets.get('batikcode.providerRouter.keys.gemini');
			if (!accountsJson) {
				return undefined;
			}
			const accounts: { enabled?: boolean; secret?: string }[] = JSON.parse(accountsJson);
			return accounts.find(a => a.enabled && a.secret)?.secret;
		} catch {
			return undefined;
		}
	}

	/**
	 * Runs the Google Cloud Code PKCE OAuth flow used by Gemini CLI and Antigravity.
	 * Based on the NesaRouter Antigravity preset implementation.
	 */
	private async connectGoogleOAuth(profile: OAuthBootstrapProfile): Promise<void> {
		const flow = profile.oauthFlow!;

		// Generate PKCE code verifier (43-128 chars) and challenge (S256).
		const codeVerifier = randomBytes(32).toString('base64url');
		const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

		// Build the authorization URL.
		const params = new URLSearchParams({
			client_id: flow.clientId,
			redirect_uri: flow.redirectUri,
			response_type: 'code',
			scope: flow.scope,
			code_challenge: codeChallenge,
			code_challenge_method: 'S256',
			...(flow.extraParams ?? {})
		});
		const authorizeUrl = `${flow.authorizeUrl}?${params.toString()}`;

		// Open the browser for Google sign-in.
		const displayName = profile.displayName;
		void vscode.env.openExternal(vscode.Uri.parse(authorizeUrl));
		this.output.appendLine(`[oauth] ${displayName}: opened browser → ${authorizeUrl.slice(0, 100)}…`);

		// Two flows:
		// - manualCodeFlow (Gemini CLI): user pastes the short auth code (e.g. "4/xxxxx")
		// - redirect URL (Antigravity): user pastes the full redirect URL, we extract the code
		let code: string;
		if (flow.manualCodeFlow) {
			const deviceCode = await vscode.window.showInputBox({
				title: `${displayName} — Paste Authorization Code`,
				prompt: 'After signing in at codeassist.google.com, you will see a code like "4/xxxxxxxxx". Copy and paste it here.',
				placeHolder: '4/xxxxxxxxxxxxxxxxxxxx',
				password: true,
				ignoreFocusOut: true,
				validateInput: value => {
					if (!value.trim()) { return 'Paste the authorization code.'; }
					return undefined;
				}
			});
			if (!deviceCode) {
				throw new Error(`${displayName} sign-in was cancelled.`);
			}
			code = extractAuthorizationCode(deviceCode);
		} else {
			const redirectUrl = await vscode.window.showInputBox({
				title: `${displayName} — Paste Redirect URL`,
				prompt: 'After signing in, your browser will redirect. Copy the full URL from the address bar (starts with http://127.0.0.1:51121/oauth2callback?code=…) and paste it here.',
				placeHolder: 'http://127.0.0.1:51121/oauth2callback?code=…',
				ignoreFocusOut: true,
				validateInput: value => {
					if (!value.trim()) { return 'Paste the redirect URL from your browser.'; }
					try {
						const url = new URL(value.trim());
						if (!url.searchParams.has('code')) {
							return 'The URL must contain a "code" parameter.';
						}
						return undefined;
					} catch {
						return 'Enter a valid URL starting with http://127.0.0.1:51121/oauth2callback.';
					}
				}
			});
			if (!redirectUrl) {
				throw new Error(`${displayName} sign-in was cancelled.`);
			}
			code = extractAuthorizationCode(redirectUrl);
		}

		// Exchange the authorization code for tokens.
		this.output.appendLine(`[oauth] ${displayName}: exchanging code for tokens…`);
		const tokenResponse = await fetch(flow.tokenUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				client_id: flow.clientId,
				...(flow.clientSecret ? { client_secret: flow.clientSecret } : {}),
				code,
				code_verifier: codeVerifier,
				grant_type: 'authorization_code',
				redirect_uri: flow.redirectUri
			}).toString()
		});

		if (!tokenResponse.ok) {
			const errorText = await tokenResponse.text();
			throw new Error(`Token exchange failed (HTTP ${tokenResponse.status}): ${errorText.slice(0, 300)}`);
		}

		const tokens = await tokenResponse.json() as {
			access_token: string;
			refresh_token?: string;
			expires_in: number;
			token_type: string;
		};

		if (!tokens.access_token) {
			throw new Error('Token exchange did not return an access token.');
		}

		// Store tokens securely.
		await this.storeOAuthTokens(profile.id, {
			accessToken: tokens.access_token,
			refreshToken: tokens.refresh_token,
			// A missing expires_in would otherwise store NaN, which compares false
			// against every expiry check and hides an expired token forever.
			expiresAt: Date.now() + (Number(tokens.expires_in) > 0 ? Number(tokens.expires_in) : 3600) * 1000
		});

		this.output.appendLine(`[oauth] ${displayName}: tokens stored (expires in ${tokens.expires_in ?? 3600}s, refresh token ${tokens.refresh_token ? 'present' : 'absent'})`);

		// Validate the token by calling the loadCodeAssist endpoint.
		try {
			const valid = await validateCloudCodeToken(profile.id as CloudCodeOAuthId, tokens.access_token);
			if (!valid) {
				this.output.appendLine(`[oauth] ${displayName}: token validation failed — token may not have Cloud Code access.`);
				void vscode.window.showWarningMessage(
					`${displayName} token stored but validation failed. It may not have Cloud Code access — check your Google account or project.`
				);
			}
		} catch (validationError) {
			this.output.appendLine(`[oauth] ${displayName}: token validation error: ${safeErrorMessage(validationError)}`);
		}

		void vscode.window.showInformationMessage(`${displayName} connected. Models are now available in Chat Models.`);
		await this.refreshModelAvailability(true);
	}

	private async storeOAuthTokens(providerId: OAuthBootstrapId, tokens: StoredOAuthTokens): Promise<void> {
		await this.context.secrets.store(`batikcode.oauth.${providerId}`, JSON.stringify(tokens));
		// The cached probe answers predate these tokens; leaving them would report
		// the provider as disconnected until the TTL lapsed.
		this.statusCache.delete(providerId);
		this.chatModelsCache.delete(providerId);
		if (isCloudCodeOAuthId(providerId)) {
			// A different account may be entitled to a different project.
			this.cloudCodeProjects.delete(providerId);
		}
	}

	private async getOAuthTokens(providerId: OAuthBootstrapId): Promise<StoredOAuthTokens | undefined> {
		try {
			const stored = await this.context.secrets.get(`batikcode.oauth.${providerId}`);
			return stored ? JSON.parse(stored) : undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * Returns the stored tokens, exchanging the refresh token first when the
	 * access token is at or near expiry. Google access tokens last an hour, so
	 * without this a connection goes dead an hour after sign-in even though a
	 * refresh token is on hand.
	 */
	private async getValidTokens(id: OAuthBootstrapId): Promise<StoredOAuthTokens | undefined> {
		const tokens = await this.getOAuthTokens(id);
		if (!tokens || tokens.expiresAt >= Date.now() + TOKEN_REFRESH_LEAD_MS || !tokens.refreshToken) {
			return tokens;
		}

		const flow = PROFILES[id].oauthFlow;
		if (!flow) {
			return tokens;
		}

		// Concurrent callers (status polling, model listing, a chat request) must
		// not race three refreshes against the same token.
		let refresh = this.refreshInFlightById.get(id);
		if (!refresh) {
			refresh = this.refreshTokens(id, flow, tokens).finally(() => this.refreshInFlightById.delete(id));
			this.refreshInFlightById.set(id, refresh);
		}
		return refresh;
	}

	private async refreshTokens(id: OAuthBootstrapId, flow: OAuthFlowConfig, tokens: StoredOAuthTokens): Promise<StoredOAuthTokens> {
		this.output.appendLine(`[oauth] ${PROFILES[id].displayName}: refreshing access token…`);
		try {
			const response = await fetch(flow.tokenUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({
					client_id: flow.clientId,
					...(flow.clientSecret ? { client_secret: flow.clientSecret } : {}),
					grant_type: 'refresh_token',
					refresh_token: tokens.refreshToken!
				}).toString()
			});
			if (!response.ok) {
				const errorText = await response.text();
				this.output.appendLine(`[oauth] refresh failed (HTTP ${response.status}): ${errorText.slice(0, 300)}`);
				return tokens;
			}
			const refreshed = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
			if (!refreshed.access_token) {
				this.output.appendLine('[oauth] refresh response contained no access token.');
				return tokens;
			}
			const updated: StoredOAuthTokens = {
				accessToken: refreshed.access_token,
				// Google omits refresh_token on refresh; keep the one we have.
				refreshToken: refreshed.refresh_token ?? tokens.refreshToken,
				expiresAt: Date.now() + (refreshed.expires_in ?? 3600) * 1000
			};
			await this.storeOAuthTokens(id, updated);
			this.output.appendLine(`[oauth] ${PROFILES[id].displayName}: token refreshed (expires in ${refreshed.expires_in ?? 3600}s)`);
			return updated;
		} catch (error) {
			this.output.appendLine(`[oauth] refresh error: ${safeErrorMessage(error)}`);
			return tokens;
		}
	}

	/**
	 * Ensures the official CLI is installed. If the bundled binary or npm package
	 * is available, offers to install automatically. Returns true when ready.
	 */
	public async ensureInstalled(id: OAuthBootstrapId): Promise<boolean> {
		const profile = PROFILES[id];
		if (await findExecutable(profile.executable)) {
			return true;
		}

		const canInstall = Boolean(profile.npmPackage);
		const installLabel = canInstall
			? `Install ${profile.displayName} CLI (npm)`
			: 'Install manually';

		const detail = canInstall
			? `BatikCode can install ${profile.displayName} CLI via npm. This requires Node.js and npm on your PATH.`
			: `${profile.displayName} CLI is not installed. Download it from the official site and ensure it is on your PATH.`;

		const chosen = await vscode.window.showWarningMessage(
			`${profile.displayName} CLI is not installed. ${detail}`,
			{ modal: true },
			installLabel
		);

		if (chosen !== installLabel || !canInstall) {
			void vscode.window.showErrorMessage(`${profile.displayName} is not installed or is not available on PATH.`);
			return false;
		}

		return vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: `Installing ${profile.displayName} CLI…`,
				cancellable: false
			},
			async () => {
				try {
					await installNpmPackage(profile.npmPackage!, this.output);
					this.output.appendLine(`[npm] ${profile.displayName} CLI installed successfully.`);
					void vscode.window.showInformationMessage(`${profile.displayName} CLI installed. You can now sign in.`);
					return true;
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					this.output.appendLine(`[npm] ${profile.displayName} installation failed: ${message}`);
					void vscode.window.showErrorMessage(
						`${profile.displayName} installation failed: ${message}\n\nInstall manually: npm i -g ${profile.npmPackage}`,
						'Open Terminal'
					).then(action => {
						if (action === 'Open Terminal') {
							const terminal = this.createTerminal(`${profile.displayName} Install`);
							terminal.show();
							terminal.sendText(`npm i -g ${profile.npmPackage}`, true);
						}
					});
					return false;
				}
			}
		);
	}

	public async test(id: OAuthBootstrapId): Promise<void> {
		const profile = PROFILES[id];
		if (!profile.testCommand) {
			await this.connect(id);
			return;
		}
		if (!await this.ensureInstalled(id)) {
			void vscode.window.showErrorMessage(`${profile.displayName} is not installed or is not available on PATH.`);
			return;
		}
		if (profile.testUsesQuota) {
			const confirmation = await vscode.window.showWarningMessage(
				`Test ${profile.displayName}? This sends a real provider request and may use account quota.`,
				{ modal: true },
				'Run Test'
			);
			if (confirmation !== 'Run Test') {
				return;
			}
		}
		const terminal = this.createTerminal(`${profile.displayName} Test`);
		terminal.show();
		terminal.sendText(profile.testCommand, true);
	}

	public async manage(id: OAuthBootstrapId): Promise<void> {
		const profile = PROFILES[id];
		const status = await this.getStatus(id);
		const choices: vscode.QuickPickItem[] = [
			{
				label: status.connected ? '$(sync) Reconnect' : '$(sign-in) Sign in',
				description: `Use the OAuth flow managed by ${profile.displayName}`
			}
		];
		if (profile.testCommand) {
			choices.push({
				label: '$(debug-start) Test connection',
				description: profile.testUsesQuota ? 'Sends one small real request' : 'Checks the current authentication status'
			});
		}
		if (status.connected && profile.signOutCommand) {
			choices.push({
				label: '$(sign-out) Sign out',
				description: `Remove the local ${profile.displayName} session through its official client`
			});
		}
		choices.push({
			label: '$(output) Show bootstrap log',
			description: 'The log contains status messages only, never tokens'
		});

		const selected = await vscode.window.showQuickPick(choices, {
			title: `${profile.displayName} local testing`,
			placeHolder: status.detail
		});
		if (!selected) {
			return;
		}
		if (selected.label.includes('Test connection')) {
			await this.test(id);
		} else if (selected.label.includes('Sign out')) {
			await this.signOut(profile);
		} else if (selected.label.includes('log')) {
			this.output.show();
		} else {
			try {
				await this.connect(id);
			} catch (error) {
				// A failed sign-in must not swallow the refresh below, otherwise the
				// panel keeps showing the pre-attempt status with no explanation.
				const message = safeErrorMessage(error);
				this.output.appendLine(`[oauth] ${profile.displayName}: sign-in failed — ${message}`);
				void vscode.window.showErrorMessage(`${profile.displayName} sign-in failed: ${message}`, 'Show Log')
					.then(choice => { if (choice === 'Show Log') { this.output.show(); } });
			}
		}
		void this.refreshModelAvailability(true);
	}

	private async refreshModelAvailability(force = false): Promise<void> {
		if (this.refreshInFlight) {
			return;
		}
		this.refreshInFlight = true;
		try {
			const [codex, gemini] = await Promise.all([
				this.getChatModels('codex-cli', force),
				this.getChatModels('gemini-cli', force)
			]);
			const fingerprint = JSON.stringify({ codex, gemini });
			if (force || (this.lastModelFingerprint !== undefined && fingerprint !== this.lastModelFingerprint)) {
				this.changeEmitter.fire();
			}
			this.lastModelFingerprint = fingerprint;
		} finally {
			this.refreshInFlight = false;
		}
	}

	private async signOut(profile: OAuthBootstrapProfile): Promise<void> {
		if (!profile.signOutCommand) {
			return;
		}
		const confirmation = await vscode.window.showWarningMessage(
			`Sign out of ${profile.displayName} on this computer? This affects the official client session outside BatikCode too.`,
			{ modal: true },
			'Sign Out'
		);
		if (confirmation !== 'Sign Out') {
			return;
		}
		const terminal = this.createTerminal(`${profile.displayName} Sign Out`);
		terminal.show();
		terminal.sendText(profile.signOutCommand, true);
	}

	private createTerminal(name: string): vscode.Terminal {
		return vscode.window.createTerminal({
			name: `BatikCode · ${name}`,
			cwd: vscode.workspace.workspaceFolders?.[0]?.uri
		});
	}

	private async confirmTemporaryMode(providerName: string): Promise<boolean> {
		const acknowledgementKey = 'batikcode.providerBootstrap.temporaryModeAcknowledged';
		if (this.context.globalState.get<boolean>(acknowledgementKey)) {
			return true;
		}
		const confirmation = await vscode.window.showWarningMessage(
			`${providerName} will use the installed official client for local testing. This bootstrap mode is intended for private development, not a distributed BatikCode release.`,
			{ modal: true },
			'Continue'
		);
		if (confirmation !== 'Continue') {
			return false;
		}
		await this.context.globalState.update(acknowledgementKey, true);
		this.output.info('Temporary local provider bootstrap mode acknowledged.');
		return true;
	}
}

interface ProcessResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

async function run(executable: string, args: readonly string[]): Promise<ProcessResult> {
	return new Promise(resolve => {
		const invocation = createCliInvocation(executable, args);
		execFile(invocation.target, invocation.args, {
			windowsHide: true,
			timeout: 10_000,
			maxBuffer: 256 * 1024
		}, (error, stdout, stderr) => {
			const exitCode = typeof error?.code === 'number' ? error.code : error ? 1 : 0;
			resolve({ exitCode, stdout: String(stdout), stderr: String(stderr) });
		});
	});
}

async function findExecutable(command: string): Promise<string | undefined> {
	const pathValue = process.env.PATH ?? '';
	const extensions = process.platform === 'win32'
		? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD;.PS1').split(';')
		: [''];
	for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
		for (const extension of extensions) {
			const suffix = process.platform === 'win32' ? extension.toLowerCase() : extension;
			const candidate = path.join(directory, `${command}${suffix}`);
			try {
				await access(candidate);
				return candidate;
			} catch {
				// Continue searching the remaining PATH entries.
			}
		}
	}
	return undefined;
}

async function resolveWorkingDirectory(): Promise<string> {
	return resolveCliWorkingDirectory({
		workspaceDirectory: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
		fallbackDirectories: [process.env.VSCODE_CWD, process.cwd()],
		homeDirectory: homedir()
	});
}

async function runWithInput(
	executable: string,
	args: readonly string[],
	input: string,
	cwd: string,
	token: vscode.CancellationToken
): Promise<string> {
	return new Promise((resolve, reject) => {
		const invocation = createCliInvocation(executable, args);
		const child = spawn(invocation.target, invocation.args, {
			cwd,
			windowsHide: true,
			stdio: ['pipe', 'pipe', 'pipe']
		});
		let stdout = '';
		let stderr = '';
		const timeout = setTimeout(() => {
			child.kill();
			reject(new Error(`${path.basename(executable)} did not respond within 2 minutes.`));
		}, 120_000);
		const cancellation = token.onCancellationRequested(() => child.kill());
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', chunk => stdout += String(chunk).slice(0, 2_000_000 - stdout.length));
		child.stderr.on('data', chunk => stderr += String(chunk).slice(0, 256_000 - stderr.length));
		child.on('error', error => {
			clearTimeout(timeout);
			cancellation.dispose();
			reject(error);
		});
		child.on('close', code => {
			clearTimeout(timeout);
			cancellation.dispose();
			if (token.isCancellationRequested) {
				reject(new Error(`${path.basename(executable)} request was cancelled.`));
			} else if (code === 0 && stdout.trim()) {
				resolve(stdout.trim());
			} else {
				const detail = stderr.trim().split(/\r?\n/).slice(-4).join(' ').slice(0, 500);
				reject(new Error(detail || `${path.basename(executable)} exited with code ${code ?? 'unknown'}.`));
			}
		});
		child.stdin.end(input);
	});
}

function requiresNewerCodex(error: unknown): boolean {
	return error instanceof Error && /requires a newer version of Codex/i.test(error.message);
}

function isTransientCliError(error: unknown): boolean {
	if (error instanceof Error) {
		const message = error.message;
		if (/sorry, your request failed.*please try again/i.test(message)) {
			return true;
		}
		if (/requires a newer version of codex/i.test(message)) {
			return false;
		}
		if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ECONNRESET|EPIPE/i.test(message)) {
			return true;
		}
		if (/5\d\d|rate.limit|too.many.requests|quota/i.test(message)) {
			return true;
		}
	}
	return false;
}

async function runWithRetry(
	executable: string,
	args: readonly string[],
	input: string,
	cwd: string,
	token: vscode.CancellationToken,
	maxAttempts = 4
): Promise<string> {
	let lastError: unknown;
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		if (token.isCancellationRequested) {
			throw new Error(`${path.basename(executable)} request was cancelled.`);
		}
		try {
			return await runWithInput(executable, args, input, cwd, token);
		} catch (error) {
			lastError = error;
			if (!isTransientCliError(error) || attempt >= maxAttempts - 1) {
				throw error;
			}
			const delay = Math.pow(2, attempt) * 1000;
			await new Promise(resolve => setTimeout(resolve, delay));
		}
	}
	throw lastError;
}

const CLOUD_CODE_BASE_URL = 'https://cloudcode-pa.googleapis.com/v1internal';

interface CloudCodeProfile {
	readonly headers: Readonly<Record<string, string>>;
	readonly metadata: Readonly<Record<string, string>>;
}

const CLOUD_CODE_PROFILES: Readonly<Record<CloudCodeOAuthId, CloudCodeProfile>> = {
	'gemini-cli': {
		headers: {
			'User-Agent': 'google-genai-sdk/1.41.0 gl-node/v22.19.0',
			'X-Goog-Api-Client': 'google-genai-sdk/1.41.0 gl-node/v22.19.0'
		},
		metadata: { ideType: 'GEMINI_CLI', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' }
	},
	antigravity: {
		headers: {
			'User-Agent': 'antigravity/ide/2.1.1',
			'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
			'Client-Metadata': JSON.stringify({ ideType: 9, platform: 5, pluginType: 2 })
		},
		metadata: { ideType: 'ANTIGRAVITY', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' }
	}
};

function isCloudCodeOAuthId(id: OAuthBootstrapId): id is CloudCodeOAuthId {
	return id === 'gemini-cli' || id === 'antigravity';
}

function cloudCodeHeaders(id: CloudCodeOAuthId, accessToken: string): Record<string, string> {
	return {
		'Content-Type': 'application/json',
		Authorization: `Bearer ${accessToken}`,
		...CLOUD_CODE_PROFILES[id].headers
	};
}

async function validateCloudCodeToken(id: CloudCodeOAuthId, accessToken: string): Promise<boolean> {
	return Boolean(await loadCloudCodeProject(id, accessToken));
}

/**
 * Resolves the Cloud Code project the token is entitled to. Every
 * generateContent call must carry it, so a token alone is not enough to chat.
 * Returns undefined when the endpoint rejects the token.
 */
async function loadCloudCodeProject(id: CloudCodeOAuthId, accessToken: string): Promise<string | undefined> {
	try {
		const response = await fetch(`${CLOUD_CODE_BASE_URL}:loadCodeAssist`, {
			method: 'POST',
			headers: cloudCodeHeaders(id, accessToken),
			body: JSON.stringify({ metadata: CLOUD_CODE_PROFILES[id].metadata }),
			signal: AbortSignal.timeout(20_000)
		});
		if (!response.ok) {
			return undefined;
		}
		const payload = await response.json() as CloudCodeProjectResponse;
		const project = cloudCodeProjectId(payload);
		if (project) {
			return project;
		}

		// Free Code Assist accounts receive their project asynchronously. Mirror
		// the official CLI flow instead of advertising OAuth as ready too early.
		const tierId = payload.currentTier?.id === 'FREE'
			? 'FREE'
			: payload.allowedTiers?.find(tier => tier.isDefault)?.id;
		if (tierId !== 'FREE') {
			return '';
		}
		const onboardUrl = `${CLOUD_CODE_BASE_URL}:onboardUser`;
		for (let attempt = 0; attempt < 10; attempt++) {
			const onboardResponse = await fetch(onboardUrl, {
				method: 'POST',
				headers: cloudCodeHeaders(id, accessToken),
				body: JSON.stringify({ tierId, metadata: CLOUD_CODE_PROFILES[id].metadata }),
				signal: AbortSignal.timeout(20_000)
			});
			if (!onboardResponse.ok) {
				return '';
			}
			const onboardPayload = await onboardResponse.json() as CloudCodeProjectResponse;
			const onboardedProject = cloudCodeProjectId(onboardPayload);
			if (onboardedProject) {
				return onboardedProject;
			}
			if (onboardPayload.done) {
				return '';
			}
			await new Promise(resolve => setTimeout(resolve, 5_000));
		}
		return '';
	} catch {
		return undefined;
	}
}

interface CloudCodeProjectResponse {
	readonly cloudaicompanionProject?: string | { readonly id?: string };
	readonly project?: string | { readonly id?: string };
	readonly response?: { readonly cloudaicompanionProject?: string | { readonly id?: string } };
	readonly currentTier?: { readonly id?: string };
	readonly allowedTiers?: readonly { readonly id?: string; readonly isDefault?: boolean }[];
	readonly done?: boolean;
}

function cloudCodeProjectId(payload: CloudCodeProjectResponse): string | undefined {
	const value = payload.cloudaicompanionProject ?? payload.project ?? payload.response?.cloudaicompanionProject;
	if (typeof value === 'string') {
		return value.trim() || undefined;
	}
	return value?.id?.trim() || undefined;
}

/** A tool the model may call, in the shape Gemini declares them. */
export interface CloudCodeTool {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: object;
}

/** One turn of a Cloud Code conversation, already reduced to Gemini's roles. */
export interface CloudCodeTurn {
	readonly role: 'user' | 'model';
	readonly parts: readonly object[];
}

export interface CloudCodeReply {
	readonly text: string;
	readonly toolCalls: readonly { id: string; name: string; arguments: object }[];
}

/**
 * Sends a conversation through Cloud Code using a Gemini CLI or Antigravity OAuth token.
 *
 * Unlike the CLI transports, this speaks Gemini's HTTP API directly, so it can
 * declare tools and return the model's `functionCall` parts — which is what lets
 * Cloud Code models drive agent mode instead of only answering questions.
 */
async function requestCloudCodeChat(
	id: CloudCodeOAuthId,
	accessToken: string,
	project: string,
	model: string,
	contents: readonly CloudCodeTurn[],
	systemInstruction: string | undefined,
	tools: readonly CloudCodeTool[] | undefined,
	toolMode: 'auto' | 'required',
	signal: AbortSignal
): Promise<CloudCodeReply> {
	const request: Record<string, unknown> = { contents };
	if (systemInstruction) {
		request.systemInstruction = { parts: [{ text: systemInstruction }] };
	}
	if (tools?.length) {
		request.tools = [{
			functionDeclarations: tools.map(tool => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.inputSchema
			}))
		}];
		request.toolConfig = { functionCallingConfig: { mode: toolMode === 'required' ? 'ANY' : 'AUTO' } };
	}

	const response = await fetch(`${CLOUD_CODE_BASE_URL}:generateContent`, {
		method: 'POST',
		headers: cloudCodeHeaders(id, accessToken),
		body: JSON.stringify({ project, model, request }),
		signal
	});
	if (!response.ok) {
		const detail = (await response.text().catch(() => '')).slice(0, 300);
		throw new Error(`${PROFILES[id].displayName} request failed (HTTP ${response.status}): ${detail}`);
	}

	type Part = { text?: unknown; functionCall?: { name?: unknown; args?: unknown } };
	const payload = await response.json() as {
		response?: { candidates?: readonly { content?: { parts?: readonly Part[] } }[] };
		candidates?: readonly { content?: { parts?: readonly Part[] } }[];
	};
	// Cloud Code nests the Gemini reply under `response`; accept the bare shape too.
	const parts = (payload.response?.candidates ?? payload.candidates ?? [])
		.flatMap(candidate => candidate.content?.parts ?? []);

	const text = parts.map(part => (typeof part.text === 'string' ? part.text : '')).filter(Boolean).join('');
	const toolCalls = parts
		.filter(part => part.functionCall && typeof part.functionCall.name === 'string')
		.map((part, index) => ({
			// Gemini does not issue call ids; the workbench needs one to pair the
			// result back, and name+index is unique within a single reply.
			id: `${part.functionCall!.name as string}-${index}`,
			name: part.functionCall!.name as string,
			arguments: (part.functionCall!.args ?? {}) as object
		}));

	if (!text && !toolCalls.length) {
		throw new Error(`${PROFILES[id].displayName} returned neither text nor a tool call.`);
	}
	return { text, toolCalls };
}

function safeErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Normalizes whatever the user pasted into a bare authorization code. Google's
 * consent page renders the code percent-encoded, and users routinely paste the
 * whole redirect URL — or a `code=…` fragment — instead of the code alone. Any
 * of those forwarded verbatim make the token exchange fail with `invalid_grant`.
 */
export function extractAuthorizationCode(pasted: string): string {
	let value = pasted.trim().replace(/^["']|["']$/g, '');
	if (/^https?:\/\//i.test(value)) {
		const url = new URL(value);
		// searchParams decodes for us.
		const fromQuery = url.searchParams.get('code');
		if (!fromQuery) {
			throw new Error(url.searchParams.get('error') || 'The pasted URL contains no "code" parameter.');
		}
		return fromQuery;
	}
	value = value.replace(/^code=/i, '');
	if (/%[0-9A-Fa-f]{2}/.test(value)) {
		try {
			value = decodeURIComponent(value);
		} catch {
			// Not valid percent-encoding after all — send what the user gave us.
		}
	}
	if (!value) {
		throw new Error('No authorization code was provided.');
	}
	return value;
}

/**
 * Installs an npm package globally. Used to bootstrap the official CLIs
 * (Codex, Gemini) that BatikCode bundles OAuth presets for.
 */
async function installNpmPackage(packageName: string, output: vscode.OutputChannel): Promise<void> {
	// Find npm first — it should already be on PATH since BatikCode requires Node.js.
	const npm = await findExecutable('npm');
	if (!npm) {
		throw new Error('npm is not available. Install Node.js (https://nodejs.org) and ensure it is on your PATH.');
	}

	const args = ['install', '-g', packageName];
	output.appendLine(`[npm] Installing ${packageName} (this may take a moment)…`);

	return new Promise((resolve, reject) => {
		const child = spawn(npm, args, {
			windowsHide: true,
			stdio: 'pipe',
			env: { ...process.env }
		});

		let stderr = '';
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', chunk => {
			stderr += String(chunk);
			output.appendLine(`[npm] ${String(chunk).trim()}`);
		});

		child.on('error', error => {
			reject(new Error(`Failed to start npm: ${error.message}`));
		});

		child.on('close', code => {
			if (code === 0) {
				output.appendLine(`[npm] install -g ${packageName} completed.`);
				resolve();
			} else {
				const lastLines = stderr.trim().split(/\r?\n/).slice(-3).join(' ');
				reject(new Error(lastLines || `npm exited with code ${code}`));
			}
		});
	});
}
