/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

export interface SshHost {
	readonly alias: string;
	readonly hostName?: string;
	readonly user?: string;
}

type RemoteTreeItem =
	| { readonly kind: 'host'; readonly host: SshHost }
	| { readonly kind: 'action'; readonly label: string; readonly description: string; readonly icon: string; readonly command: string };

const SSH_CONFIG_PATH = path.join(os.homedir(), '.ssh', 'config');

export class RemoteHostsProvider implements vscode.TreeDataProvider<RemoteTreeItem> {
	private readonly changeEmitter = new vscode.EventEmitter<RemoteTreeItem | undefined>();
	readonly onDidChangeTreeData = this.changeEmitter.event;

	public refresh(): void {
		this.changeEmitter.fire(undefined);
	}

	public getTreeItem(item: RemoteTreeItem): vscode.TreeItem {
		if (item.kind === 'host') {
			const treeItem = new vscode.TreeItem(item.host.alias, vscode.TreeItemCollapsibleState.None);
			treeItem.description = [item.host.user, item.host.hostName].filter(Boolean).join('@');
			treeItem.tooltip = `SSH host ${item.host.alias}${treeItem.description ? ` (${treeItem.description})` : ''}`;
			treeItem.iconPath = new vscode.ThemeIcon('remote');
			treeItem.contextValue = 'sshHost';
			treeItem.command = {
				command: 'batikcode.remoteExplorer.connectWorkspace',
				title: 'Open Remote Workspace',
				arguments: [item.host]
			};
			return treeItem;
		}

		const treeItem = new vscode.TreeItem(item.label, vscode.TreeItemCollapsibleState.None);
		treeItem.description = item.description;
		treeItem.iconPath = new vscode.ThemeIcon(item.icon);
		treeItem.command = { command: item.command, title: item.label };
		return treeItem;
	}

	public async getChildren(_element?: RemoteTreeItem): Promise<RemoteTreeItem[]> {
		const hosts = await readSshHosts();
		if (hosts.length) {
			return hosts.map(host => ({ kind: 'host' as const, host }));
		}
		return [{
			kind: 'action',
			label: 'Open SSH Configuration',
			description: 'No concrete Host entries found',
			icon: 'settings-gear',
			command: 'batikcode.remoteExplorer.openSshConfig'
		}];
	}
}

export class RemoteToolsProvider implements vscode.TreeDataProvider<RemoteTreeItem> {
	public getTreeItem(item: RemoteTreeItem): vscode.TreeItem {
		const treeItem = new vscode.TreeItem(item.kind === 'action' ? item.label : item.host.alias);
		if (item.kind === 'action') {
			treeItem.description = item.description;
			treeItem.iconPath = new vscode.ThemeIcon(item.icon);
			treeItem.command = { command: item.command, title: item.label };
		}
		return treeItem;
	}

	public getChildren(_element?: RemoteTreeItem): RemoteTreeItem[] {
		return [
			{ kind: 'action', label: 'Forward a Port', description: 'Native Ports view', icon: 'radio-tower', command: 'remote.tunnel.forwardCommandPalette' },
			{ kind: 'action', label: 'Start Cloudflare Dev Tunnel', description: 'Public development URL', icon: 'cloud', command: 'batikcode.devTunnel.start' },
			{ kind: 'action', label: 'Open Browser Preview', description: 'Integrated web preview', icon: 'globe', command: 'batikcode.browserPreview.open' },
			{ kind: 'action', label: 'Open SSH Configuration', description: SSH_CONFIG_PATH, icon: 'settings-gear', command: 'batikcode.remoteExplorer.openSshConfig' }
		];
	}
}

export async function connectSshTerminal(host: SshHost): Promise<void> {
	const hosts = await readSshHosts();
	const cfg = hosts.find(h => h.alias === host.alias);
	const args = [`ssh`];
	if (cfg?.user) {
		args.push('-l', cfg.user);
	}
	if (cfg?.hostName && cfg.hostName !== cfg.alias) {
		args.push(cfg.hostName);
	} else {
		args.push(cfg?.alias ?? host.alias);
	}
	const terminal = vscode.window.createTerminal({ name: `SSH: ${host.alias}` });
	terminal.show();
	terminal.sendText(args.map(quoteTerminalArgument).join(' '), true);
}

export async function connectRemoteWorkspace(host: SshHost): Promise<void> {
	await vscode.commands.executeCommand('batikcoderemotessh.openEmptyWindow', host.alias);
}

export async function openSshConfig(): Promise<void> {
	try {
		await fs.access(SSH_CONFIG_PATH);
	} catch {
		const create = await vscode.window.showInformationMessage(
			`SSH configuration does not exist at ${SSH_CONFIG_PATH}.`,
			'Create'
		);
		if (create !== 'Create') {
			return;
		}
		await fs.mkdir(path.dirname(SSH_CONFIG_PATH), { recursive: true });
		await fs.writeFile(SSH_CONFIG_PATH, '# BatikCode SSH hosts\n\n', { flag: 'wx' });
	}
	const document = await vscode.workspace.openTextDocument(vscode.Uri.file(SSH_CONFIG_PATH));
	await vscode.window.showTextDocument(document);
}

async function readSshHosts(): Promise<readonly SshHost[]> {
	const configDir = path.dirname(SSH_CONFIG_PATH);
	const lines: string[] = [];
	await collectSshConfigLines(SSH_CONFIG_PATH, configDir, lines, new Set());

	const hosts: SshHost[] = [];
	let current: { aliases: string[]; hostName?: string; user?: string } | undefined;
	const flush = () => {
		if (!current) {
			return;
		}
		for (const alias of current.aliases) {
			if (isConcreteSshAlias(alias)) {
				hosts.push({ alias, hostName: current.hostName, user: current.user });
			}
		}
	};

	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#')) {
			continue;
		}
		const match = /^(\S+)\s+(.+)$/.exec(line);
		if (!match) {
			continue;
		}
		const key = match[1].toLowerCase();
		const value = match[2].trim();
		if (key === 'host') {
			flush();
			current = { aliases: value.split(/\s+/) };
		} else if (current && key === 'hostname') {
			current.hostName = value;
		} else if (current && key === 'user') {
			current.user = value;
		}
	}
	flush();
	return hosts.sort((left, right) => left.alias.localeCompare(right.alias));
}

async function collectSshConfigLines(
	filePath: string,
	cwd: string,
	out: string[],
	seen: Set<string>
): Promise<void> {
	const resolved = path.resolve(cwd, filePath);
	if (seen.has(resolved)) {
		return; // guard against circular includes
	}
	seen.add(resolved);

	let source: string;
	try {
		source = await fs.readFile(resolved, 'utf8');
	} catch {
		return;
	}

	for (const rawLine of source.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#')) {
			out.push(rawLine);
			continue;
		}
		const match = /^include\s+(.+)$/i.exec(line);
		if (match) {
			const patterns = match[1].split(/\s+/);
			for (const pattern of patterns) {
				const absPattern = path.isAbsolute(pattern)
					? pattern
					: path.join(cwd, pattern);
				// Simple glob: resolve wildcard dirs via readdir
				await expandGlobAndCollect(absPattern, out, seen);
			}
			continue;
		}
		out.push(rawLine);
	}
}

/**
 * Minimal glob expansion for SSH Include patterns.
 * Supports *, ?, and [a-z] in the last path segment.
 */
async function expandGlobAndCollect(
	pattern: string,
	out: string[],
	seen: Set<string>
): Promise<void> {
	const hasGlob = /[*?[\]]/.test(pattern);
	if (!hasGlob) {
		await collectSshConfigLines(pattern, path.dirname(pattern), out, seen);
		return;
	}

	const dir = path.dirname(pattern);
	const basenamePattern = path.basename(pattern);
	const regex = new RegExp(
		'^' + basenamePattern.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
		'i'
	);

	let entries: string[];
	try {
		entries = await fs.readdir(dir);
	} catch {
		return;
	}

	for (const entry of entries) {
		if (regex.test(entry)) {
			await collectSshConfigLines(path.join(dir, entry), dir, out, seen);
		}
	}
}

function isConcreteSshAlias(alias: string): boolean {
	return /^[A-Za-z0-9._-]+$/.test(alias) && !alias.includes('*') && !alias.includes('?');
}

function quoteTerminalArgument(value: string): string {
	return process.platform === 'win32'
		? `"${value.replace(/"/g, '""')}"`
		: `'${value.replace(/'/g, `'\\''`)}'`;
}
