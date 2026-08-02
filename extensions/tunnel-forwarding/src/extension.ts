/*---------------------------------------------------------------------------------------------
 *  Copyright (c) BatikCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { access } from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { splitNewLines } from './split';

const CLOUDFLARED_DOWNLOAD_URL = vscode.Uri.parse('https://developers.cloudflare.com/tunnel/downloads/');
const QUICK_TUNNEL_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i;
const START_TIMEOUT = 45_000;
const CLOUDFLARED_PATH_SETTING = 'cloudflaredPath';
const DID_WARN_PUBLIC_KEY = 'batikcode.cloudflareTunnel.didWarnPublic';

export const enum TunnelPrivacyId {
	Public = 'public',
}

interface TunnelSpec {
	readonly remoteAddress: { host: string; port: number };
	readonly protocol: 'http' | 'https';
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	// Deliberately NOT gated on `vscode.env.remoteAuthority`: in remote SSH
	// windows this extension runs in the remote extension host, so the
	// `batikcode.devTunnel.start` command publishes a port that lives on the
	// remote server (where the dev service is actually running) to a public
	// trycloudflare.com URL. The remote SSH resolver only exposes ports as
	// `localhost:<port>` locally; users want a real Cloudflare domain instead.

	const logger = new Logger(vscode.l10n.t('BatikCode Cloudflare Dev Tunnel'));
	const provider = new CloudflareQuickTunnelProvider(context, logger);

	context.subscriptions.push(
		logger,
		provider,
		vscode.commands.registerCommand('tunnel-forwarding.showLog', () => logger.show()),
		vscode.commands.registerCommand('batikcode.devTunnel.start', () => startTunnelFromCommand(provider)),
		vscode.commands.registerCommand('batikcode.devTunnel.stopAll', () => provider.stopAll()),
		vscode.commands.registerCommand('batikcode.devTunnel.selectCloudflared', () => selectCloudflaredBinary()),
		vscode.commands.registerCommand('batikcode.devTunnel.openDownload', () => vscode.env.openExternal(CLOUDFLARED_DOWNLOAD_URL)),
	);

	// Register as the tunnel provider. In a remote window another tunnel
	// provider may already own the single provider slot; that's fine — the
	// commands above still publish ports to Cloudflare independently.
	try {
		context.subscriptions.push(await vscode.workspace.registerTunnelProvider(provider, {
			tunnelFeatures: {
				elevation: false,
				protocol: true,
				privacyOptions: [
					{
						themeIcon: 'globe',
						id: TunnelPrivacyId.Public,
						label: vscode.l10n.t('Public (Cloudflare Quick Tunnel)')
					}
				]
			}
		}));
	} catch (error) {
		logger.info(vscode.l10n.t('Tunnel provider slot is taken by another provider; commands remain available. ({0})', error instanceof Error ? error.message : String(error)));
	}
}

export function deactivate(): void { }

async function startTunnelFromCommand(provider: CloudflareQuickTunnelProvider): Promise<void> {
	const portValue = await vscode.window.showInputBox({
		title: vscode.l10n.t('Start Cloudflare Dev Tunnel'),
		prompt: vscode.l10n.t('Enter the localhost port to publish temporarily. The generated URL is public.'),
		placeHolder: '3000',
		ignoreFocusOut: true,
		validateInput: value => validatePort(value)
	});
	if (portValue === undefined) {
		return;
	}
	const protocol = await vscode.window.showQuickPick(
		[
			{ label: 'HTTP', description: 'http://127.0.0.1', protocol: 'http' as const },
			{ label: 'HTTPS', description: 'https://127.0.0.1', protocol: 'https' as const }
		],
		{
			title: vscode.l10n.t('Local service protocol'),
			placeHolder: vscode.l10n.t('Choose the protocol used by your local server')
		}
	);
	if (!protocol) {
		return;
	}

	try {
		const tunnel = await provider.createTunnel({
			remoteAddress: { host: '127.0.0.1', port: Number(portValue) },
			protocol: protocol.protocol
		});
		const copy = vscode.l10n.t('Copy URL');
		const preview = vscode.l10n.t('Open Preview');
		const browser = vscode.l10n.t('Open Browser');
		const action = await vscode.window.showInformationMessage(
			vscode.l10n.t('Cloudflare Dev Tunnel is active: {0}', tunnel.localAddress),
			copy,
			preview,
			browser
		);
		if (action === copy) {
			await vscode.env.clipboard.writeText(tunnel.localAddress);
		} else if (action === preview) {
			await vscode.commands.executeCommand('simpleBrowser.show', tunnel.localAddress);
		} else if (action === browser) {
			await vscode.env.openExternal(vscode.Uri.parse(tunnel.localAddress));
		}
	} catch (error) {
		await showTunnelError(error);
	}
}

async function selectCloudflaredBinary(): Promise<void> {
	const selected = await vscode.window.showOpenDialog({
		title: vscode.l10n.t('Select cloudflared executable'),
		canSelectFiles: true,
		canSelectFolders: false,
		canSelectMany: false,
		filters: process.platform === 'win32' ? { Executable: ['exe'] } : undefined
	});
	if (!selected?.[0]) {
		return;
	}
	try {
		await validateCloudflaredExecutable(selected[0].fsPath);
	} catch (error) {
		void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
		return;
	}
	await vscode.workspace.getConfiguration('batikcode.devTunnel').update(
		CLOUDFLARED_PATH_SETTING,
		selected[0].fsPath,
		vscode.ConfigurationTarget.Global
	);
	void vscode.window.showInformationMessage(vscode.l10n.t('cloudflared executable updated.'));
}

async function showTunnelError(error: unknown): Promise<void> {
	const message = error instanceof Error ? error.message : String(error);
	const select = vscode.l10n.t('Select cloudflared');
	const download = vscode.l10n.t('Open Download');
	const showLog = vscode.l10n.t('Show Log');
	const action = await vscode.window.showErrorMessage(
		vscode.l10n.t('Cloudflare Dev Tunnel failed: {0}', message),
		select,
		download,
		showLog
	);
	if (action === select) {
		await vscode.commands.executeCommand('batikcode.devTunnel.selectCloudflared');
	} else if (action === download) {
		await vscode.commands.executeCommand('batikcode.devTunnel.openDownload');
	} else if (action === showLog) {
		await vscode.commands.executeCommand('tunnel-forwarding.showLog');
	}
}

function validatePort(value: string): string | undefined {
	const port = Number(value);
	return Number.isInteger(port) && port >= 1 && port <= 65_535
		? undefined
		: vscode.l10n.t('Enter a port from 1 to 65535.');
}

class CloudflareQuickTunnel implements vscode.Tunnel {
	private readonly disposeEmitter = new vscode.EventEmitter<void>();
	private disposed = false;

	public readonly onDidDispose = this.disposeEmitter.event;
	public readonly privacy = TunnelPrivacyId.Public;

	constructor(
		public readonly remoteAddress: { host: string; port: number },
		public readonly protocol: 'http' | 'https',
		public readonly localAddress: string,
		private readonly process: ChildProcessWithoutNullStreams
	) { }

	public dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.process.kill();
		this.disposeEmitter.fire();
		this.disposeEmitter.dispose();
	}
}

class CloudflareQuickTunnelProvider implements vscode.TunnelProvider, vscode.Disposable {
	private readonly tunnels = new Set<CloudflareQuickTunnel>();

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly logger: Logger
	) { }

	public async provideTunnel(options: vscode.TunnelOptions): Promise<vscode.Tunnel | undefined> {
		if (!(await this.confirmPublicTunnel(options.remoteAddress.port))) {
			return undefined;
		}
		return this.createTunnel({
			remoteAddress: options.remoteAddress,
			protocol: options.protocol === 'https' ? 'https' : 'http'
		}, true);
	}

	public async createTunnel(spec: TunnelSpec, publicAccessConfirmed = false): Promise<CloudflareQuickTunnel> {
		if (!isLoopbackHost(spec.remoteAddress.host)) {
			throw new Error(vscode.l10n.t('Cloudflare Quick Tunnel can publish only a loopback host (127.0.0.1, localhost, or ::1).'));
		}
		if (!publicAccessConfirmed && !(await this.confirmPublicTunnel(spec.remoteAddress.port))) {
			throw new Error(vscode.l10n.t('Public tunnel creation was cancelled.'));
		}
		const executable = await resolveCloudflaredExecutable();
		const host = normalizeOriginHost(spec.remoteAddress.host);
		const origin = `${spec.protocol}://${host}:${spec.remoteAddress.port}`;
		const args = ['tunnel', '--url', origin, '--no-autoupdate'];
		this.logger.info(`[cloudflared] starting Quick Tunnel for ${origin}`);

		const child = spawn(executable, args, {
			stdio: 'pipe',
			windowsHide: true,
			env: safeChildEnvironment({ NO_COLOR: '1' })
		});

		const localAddress = await this.waitForPublicUrl(child);
		const tunnel = new CloudflareQuickTunnel(spec.remoteAddress, spec.protocol, localAddress, child);
		this.tunnels.add(tunnel);
		tunnel.onDidDispose(() => {
			this.tunnels.delete(tunnel);
			void this.updateActiveContext();
		});
		child.on('exit', code => {
			this.logger.info(`[cloudflared] tunnel for ${origin} exited with code ${code ?? 'unknown'}`);
			tunnel.dispose();
		});
		await this.updateActiveContext();
		this.logger.info(`[cloudflared] public URL ready: ${localAddress}`);
		return tunnel;
	}

	public stopAll(): void {
		for (const tunnel of [...this.tunnels]) {
			tunnel.dispose();
		}
		void this.updateActiveContext();
		void vscode.window.showInformationMessage(vscode.l10n.t('All Cloudflare Dev Tunnels stopped.'));
	}

	public dispose(): void {
		for (const tunnel of [...this.tunnels]) {
			tunnel.dispose();
		}
	}

	private async confirmPublicTunnel(port: number): Promise<boolean> {
		if (this.context.globalState.get<boolean>(DID_WARN_PUBLIC_KEY, false)) {
			return true;
		}
		const continueOnce = vscode.l10n.t('Continue Once');
		const continueAlways = vscode.l10n.t("Continue and Don't Warn Again");
		const result = await vscode.window.showWarningMessage(
			vscode.l10n.t('Port {0} will be public on a random trycloudflare.com URL. Quick Tunnels are for development only and do not support SSE.', port),
			{ modal: true },
			continueOnce,
			continueAlways
		);
		if (result === continueAlways) {
			await this.context.globalState.update(DID_WARN_PUBLIC_KEY, true);
			return true;
		}
		return result === continueOnce;
	}

	private async waitForPublicUrl(child: ChildProcessWithoutNullStreams): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			let settled = false;
			const finish = (callback: () => void) => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timeout);
				callback();
			};
			const inspect = (line: string, level: 'info' | 'error') => {
				if (level === 'info') {
					this.logger.info(`[cloudflared] ${line}`);
				} else {
					this.logger.error(`[cloudflared] ${line}`);
				}
				const match = QUICK_TUNNEL_URL_PATTERN.exec(line);
				if (match) {
					finish(() => resolve(match[0]));
				}
			};

			child.stdout.pipe(splitNewLines()).on('data', line => inspect(String(line), 'info')).resume();
			child.stderr.pipe(splitNewLines()).on('data', line => inspect(String(line), 'error')).resume();
			child.once('error', error => {
				finish(() => reject(
					(error as NodeJS.ErrnoException).code === 'ENOENT'
						? new Error(vscode.l10n.t('cloudflared was not found. Select the executable or install it from Cloudflare.'))
						: error
				));
			});
			child.once('exit', code => {
				finish(() => reject(new Error(vscode.l10n.t('cloudflared exited before a public URL was ready (code {0}).', code ?? 'unknown'))));
			});
			const timeout = setTimeout(() => {
				child.kill();
				finish(() => reject(new Error(vscode.l10n.t('Timed out waiting for a trycloudflare.com URL.'))));
			}, START_TIMEOUT);
		});
	}

	private async updateActiveContext(): Promise<void> {
		await vscode.commands.executeCommand('setContext', 'batikcodeDevTunnelActive', this.tunnels.size > 0);
	}
}

class Logger implements vscode.Disposable {
	private outputChannel?: vscode.LogOutputChannel;

	constructor(private readonly label: string) { }

	public show(): void {
		this.ensureOutputChannel().show();
	}

	public info(message: string): void {
		this.ensureOutputChannel().info(message);
	}

	public error(message: string): void {
		this.ensureOutputChannel().error(message);
	}

	public dispose(): void {
		this.outputChannel?.dispose();
	}

	private ensureOutputChannel(): vscode.LogOutputChannel {
		if (!this.outputChannel) {
			this.outputChannel = vscode.window.createOutputChannel(this.label, { log: true });
			void vscode.commands.executeCommand('setContext', 'tunnelForwardingHasLog', true);
		}
		return this.outputChannel;
	}
}

function normalizeOriginHost(host: string): string {
	if (!host || host.toLowerCase() === 'localhost') {
		return '127.0.0.1';
	}
	if (host.includes(':') && !host.startsWith('[')) {
		return `[${host}]`;
	}
	return host;
}

function isLoopbackHost(host: string): boolean {
	const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
	return !normalized || normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

async function resolveCloudflaredExecutable(): Promise<string> {
	const configured = vscode.workspace.getConfiguration('batikcode.devTunnel').get<string>(CLOUDFLARED_PATH_SETTING)?.trim();
	if (!configured) {
		return 'cloudflared';
	}
	await validateCloudflaredExecutable(configured);
	return configured;
}

async function validateCloudflaredExecutable(value: string): Promise<void> {
	if (!path.isAbsolute(value)) {
		throw new Error(vscode.l10n.t('The configured cloudflared executable must use an absolute path.'));
	}
	const expected = process.platform === 'win32' ? /^cloudflared\.exe$/i : /^cloudflared$/;
	if (!expected.test(path.basename(value))) {
		throw new Error(vscode.l10n.t('Select the official cloudflared executable.'));
	}
	await access(value);
}

function safeChildEnvironment(extra: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
	const allowed = [
		'PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'ComSpec', 'TEMP', 'TMP',
		'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA', 'PROGRAMDATA',
		'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'
	];
	return Object.fromEntries([
		...allowed.flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name] as string]]),
		...Object.entries(extra)
	]);
}
