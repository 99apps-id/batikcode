/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import {
	connectRemoteWorkspace,
	connectSshTerminal,
	openSshConfig,
	RemoteHostsProvider,
	RemoteToolsProvider,
	SshHost
} from './remoteExplorer';
import { TelegramBotController, TelegramBotState } from './telegramBot';

interface TelegramTreeNode {
	readonly label: string;
	readonly description?: string;
	readonly icon: string;
	readonly command?: string;
}

class TelegramTreeProvider implements vscode.TreeDataProvider<TelegramTreeNode>, vscode.Disposable {
	private readonly changeEmitter = new vscode.EventEmitter<TelegramTreeNode | undefined>();
	readonly onDidChangeTreeData = this.changeEmitter.event;
	private state: TelegramBotState;
	private readonly stateListener: vscode.Disposable;

	constructor(controller: TelegramBotController) {
		this.state = controller.state;
		this.stateListener = controller.onDidChangeState(state => {
			this.state = state;
			this.changeEmitter.fire(undefined);
		});
	}

	public dispose(): void {
		this.stateListener.dispose();
		this.changeEmitter.dispose();
	}

	public getTreeItem(node: TelegramTreeNode): vscode.TreeItem {
		const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
		item.description = node.description;
		item.iconPath = new vscode.ThemeIcon(node.icon);
		item.command = node.command ? { command: node.command, title: node.label } : undefined;
		return item;
	}

	public getChildren(_element?: TelegramTreeNode): TelegramTreeNode[] {
		const statusIcon = this.state.connection === 'online'
			? 'pass-filled'
			: this.state.connection === 'busy'
				? 'loading~spin'
				: this.state.connection === 'connecting'
					? 'sync~spin'
					: this.state.connection === 'error'
						? 'error'
						: 'circle-slash';
		return [
			{
				label: `Telegram: ${this.state.label}`,
				description: this.state.detail,
				icon: statusIcon,
				command: 'batikcode.telegram.openMenu'
			},
			{
				label: 'Configure BotFather Token',
				description: 'Stored in OS credential vault',
				icon: 'key',
				command: 'batikcode.telegram.configureToken'
			},
			{
				label: 'Pair Telegram User',
				description: `${this.state.allowedUserCount} allowed`,
				icon: 'link',
				command: 'batikcode.telegram.pair'
			},
			{
				label: 'Workspace Editing',
				description: this.state.workspaceEditingEnabled ? 'Enabled' : 'Disabled',
				icon: this.state.workspaceEditingEnabled ? 'shield' : 'lock',
				command: 'batikcode.telegram.enableRemoteCoding'
			}
		];
	}

}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const output = vscode.window.createOutputChannel('BatikCode Telegram Remote Coding');
	const telegram = new TelegramBotController(context, output);
	const hosts = new RemoteHostsProvider();
	const tools = new RemoteToolsProvider();
	const telegramTree = new TelegramTreeProvider(telegram);
	const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 45);
	statusBar.name = 'BatikCode Telegram Bot';
	statusBar.command = 'batikcode.telegram.openMenu';
	statusBar.show();

	const updateStatusBar = (state: TelegramBotState) => {
		const icon = state.connection === 'online'
			? '$(broadcast)'
			: state.connection === 'busy'
				? '$(loading~spin)'
				: state.connection === 'connecting'
					? '$(sync~spin)'
					: state.connection === 'error'
						? '$(error)'
						: '$(circle-slash)';
		statusBar.text = `${icon} Telegram: ${state.label}`;
		statusBar.tooltip = new vscode.MarkdownString([
			`**BatikCode Telegram Remote Coding**`,
			'',
			state.detail,
			'',
			`Allowed users: ${state.allowedUserCount}`,
			`Workspace editing: ${state.workspaceEditingEnabled ? 'enabled' : 'disabled'}`
		].join('\n'));
		statusBar.backgroundColor = state.connection === 'error'
			? new vscode.ThemeColor('statusBarItem.errorBackground')
			: undefined;
	};
	updateStatusBar(telegram.state);

	context.subscriptions.push(
		output,
		telegram,
		telegramTree,
		statusBar,
		telegram.onDidChangeState(updateStatusBar),
		vscode.window.registerTreeDataProvider('batikcode.remoteExplorer.hosts', hosts),
		vscode.window.registerTreeDataProvider('batikcode.remoteExplorer.tools', tools),
		vscode.window.registerTreeDataProvider('batikcode.remoteExplorer.telegram', telegramTree),
		vscode.commands.registerCommand('batikcode.remoteExplorer.open', () =>
			vscode.commands.executeCommand('batikcode.remoteExplorer.hosts.focus')),
		vscode.commands.registerCommand('batikcode.remoteExplorer.refresh', () => hosts.refresh()),
		vscode.commands.registerCommand('batikcode.remoteExplorer.connectTerminal', (host: SshHost) => connectSshTerminal(host)),
		vscode.commands.registerCommand('batikcode.remoteExplorer.connectWorkspace', (host: SshHost) => connectRemoteWorkspace(host)),
		vscode.commands.registerCommand('batikcode.remoteExplorer.openSshConfig', () => openSshConfig()),
		vscode.commands.registerCommand('batikcode.telegram.openMenu', () => telegram.openMenu()),
		vscode.commands.registerCommand('batikcode.telegram.configureToken', () => telegram.configureToken()),
		vscode.commands.registerCommand('batikcode.telegram.start', () => telegram.start()),
		vscode.commands.registerCommand('batikcode.telegram.stop', () => telegram.stop()),
		vscode.commands.registerCommand('batikcode.telegram.pair', () => telegram.createPairingCode()),
		vscode.commands.registerCommand('batikcode.telegram.manageChats', () => telegram.manageAllowedChats()),
		vscode.commands.registerCommand('batikcode.telegram.enableRemoteCoding', () => telegram.enableWorkspaceEditing()),
		vscode.commands.registerCommand('batikcode.telegram.cancelTask', () => {
			if (!telegram.cancelTask()) {
				void vscode.window.showInformationMessage('No Telegram coding task is running.');
			}
		}),
		vscode.commands.registerCommand('batikcode.telegram.showLog', () => telegram.showLog()),
		vscode.commands.registerCommand('batikcode.telegram.diagnose', () => telegram.diagnoseConnectivity())
	);

	await telegram.initialize();
}

export function deactivate(): void {
	// ExtensionContext disposes the controller and aborts long polling.
}
