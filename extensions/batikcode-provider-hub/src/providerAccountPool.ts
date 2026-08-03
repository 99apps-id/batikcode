/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'crypto';
import * as vscode from 'vscode';

const SECRET_KEY_PREFIX = 'batikcode.providerRouter.keys.';

interface StoredProviderAccount {
	readonly id: string;
	readonly name: string;
	readonly secret: string;
	readonly enabled: boolean;
	readonly priority: number;
	readonly createdAt: string;
}

interface RuntimeAccountHealth {
	readonly state: 'healthy' | 'cooldown' | 'error';
	readonly detail?: string;
	readonly until?: number;
	readonly lastUsedAt?: number;
}

export interface ProviderAccountSummary {
	readonly id: string;
	readonly name: string;
	readonly enabled: boolean;
	readonly priority: number;
	readonly state: 'ready' | 'healthy' | 'cooldown' | 'error' | 'disabled';
	readonly detail?: string;
}

export interface ProviderAccountCandidate {
	readonly id: string;
	readonly name: string;
	readonly secret: string;
	readonly index: number;
	readonly coolingDown: boolean;
}

export class ProviderAccountPool implements vscode.Disposable {
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	private readonly health = new Map<string, RuntimeAccountHealth>();
	private readonly lastUsedAccount = new Map<string, string>();
	public readonly onDidChange = this.changeEmitter.event;

	public constructor(private readonly context: vscode.ExtensionContext) {
		context.subscriptions.push(
			this,
			context.secrets.onDidChange(event => {
				if (event.key.startsWith(SECRET_KEY_PREFIX)) {
					this.changeEmitter.fire();
				}
			})
		);
	}

	public dispose(): void {
		this.changeEmitter.dispose();
	}

	public async getSummaries(providerId: string): Promise<readonly ProviderAccountSummary[]> {
		const accounts = await this.readAccounts(providerId);
		return accounts.map(account => {
			if (!account.enabled) {
				return { id: account.id, name: account.name, enabled: false, priority: account.priority, state: 'disabled' as const };
			}
			const health = this.getHealth(providerId, account.id);
			return {
				id: account.id,
				name: account.name,
				enabled: true,
				priority: account.priority,
				state: health?.state ?? 'ready',
				detail: health?.detail
			};
		});
	}

	public async getCandidates(providerId: string): Promise<readonly ProviderAccountCandidate[]> {
		const accounts = (await this.readAccounts(providerId))
			.filter(account => account.enabled)
			.sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt));
		if (!accounts.length) {
			return [];
		}
		const lastUsed = this.lastUsedAccount.get(providerId);
		const lastIndex = lastUsed ? accounts.findIndex(account => account.id === lastUsed) : -1;
		const pivot = lastIndex >= 0 ? (lastIndex + 1) % accounts.length : 0;
		const rotated = [...accounts.slice(pivot), ...accounts.slice(0, pivot)];
		return rotated.map(account => ({
			id: account.id,
			name: account.name,
			secret: account.secret,
			index: accounts.findIndex(candidate => candidate.id === account.id),
			coolingDown: this.getHealth(providerId, account.id)?.state === 'cooldown'
		}));
	}

	public markSuccess(providerId: string, accountId: string): void {
		this.lastUsedAccount.set(providerId, accountId);
		this.health.set(this.healthKey(providerId, accountId), { state: 'healthy', lastUsedAt: Date.now() });
		this.changeEmitter.fire();
	}

	public markFailure(providerId: string, accountId: string, detail: string, cooldownMs: number): void {
		this.health.set(this.healthKey(providerId, accountId), {
			state: cooldownMs > 0 ? 'cooldown' : 'error',
			detail: detail.slice(0, 300),
			until: cooldownMs > 0 ? Date.now() + cooldownMs : undefined
		});
		this.changeEmitter.fire();
	}

	public async manage(providerId: string, providerName: string): Promise<void> {
		const accounts = await this.readAccounts(providerId);
		const selection = await vscode.window.showQuickPick([
			{ label: '$(add) Add API account', description: 'Add one named credential', action: 'add' },
			{ label: '$(list-unordered) Import multiple keys', description: 'Create one account per key', action: 'import' },
			...accounts.map(account => {
				const health = this.getHealth(providerId, account.id);
				return {
					label: `$(${account.enabled ? 'account' : 'circle-slash'}) ${account.name}`,
					description: `Priority ${account.priority} · ${account.enabled ? health?.state ?? 'ready' : 'disabled'}`,
					action: 'account',
					accountId: account.id
				};
			})
		], {
			title: `${providerName} API accounts`,
			placeHolder: accounts.length ? `${accounts.length} account${accounts.length === 1 ? '' : 's'} configured` : 'Add the first account'
		});
		if (!selection) {
			return;
		}
		if (selection.action === 'add') {
			await this.addAccount(providerId, providerName, accounts.length);
		} else if (selection.action === 'import') {
			await this.importAccounts(providerId, providerName, accounts);
		} else if (selection.action === 'account' && selection.accountId) {
			await this.manageAccount(providerId, providerName, selection.accountId);
		}
	}

	public async clear(providerId: string): Promise<void> {
		await this.context.secrets.delete(this.secretKey(providerId));
		for (const key of [...this.health.keys()]) {
			if (key.startsWith(`${providerId}:`)) {
				this.health.delete(key);
			}
		}
		this.lastUsedAccount.delete(providerId);
	}

	private async addAccount(providerId: string, providerName: string, existingCount: number): Promise<void> {
		const name = await vscode.window.showInputBox({
			title: `${providerName} account name`,
			value: `Account ${existingCount + 1}`,
			ignoreFocusOut: true,
			validateInput: value => value.trim() ? undefined : 'Enter an account name.'
		});
		if (name === undefined) {
			return;
		}
		const secret = await this.readSecret(`${providerName} · ${name.trim()}`);
		if (secret === undefined) {
			return;
		}
		const accounts = await this.readAccounts(providerId);
		accounts.push({
			id: randomUUID(),
			name: name.trim(),
			secret,
			enabled: true,
			priority: nextPriority(accounts),
			createdAt: new Date().toISOString()
		});
		await this.writeAccounts(providerId, accounts);
		void vscode.window.showInformationMessage(`${providerName}: ${name.trim()} added to the rotation pool.`);
	}

	private async importAccounts(providerId: string, providerName: string, existing: StoredProviderAccount[]): Promise<void> {
		const value = await vscode.window.showInputBox({
			title: `${providerName} API keys`,
			prompt: 'Enter keys separated by commas, spaces, or new lines. Existing accounts are preserved.',
			password: true,
			ignoreFocusOut: true,
			validateInput: input => splitSecrets(input).length ? undefined : 'Enter at least one API key.'
		});
		if (value === undefined) {
			return;
		}
		const knownSecrets = new Set(existing.map(account => account.secret));
		const additions = splitSecrets(value)
			.filter(secret => !knownSecrets.has(secret))
			.map((secret, index): StoredProviderAccount => ({
				id: randomUUID(),
				name: `Account ${existing.length + index + 1}`,
				secret,
				enabled: true,
				priority: nextPriority(existing) + index,
				createdAt: new Date(Date.now() + index).toISOString()
			}));
		await this.writeAccounts(providerId, [...existing, ...additions]);
		void vscode.window.showInformationMessage(`${providerName}: ${additions.length} account${additions.length === 1 ? '' : 's'} added.`);
	}

	private async manageAccount(providerId: string, providerName: string, accountId: string): Promise<void> {
		const accounts = await this.readAccounts(providerId);
		const account = accounts.find(candidate => candidate.id === accountId);
		if (!account) {
			return;
		}
		const selected = await vscode.window.showQuickPick([
			{ label: '$(edit) Rename account', action: 'rename' },
			{ label: '$(key) Replace API key', action: 'replace' },
			{ label: '$(arrow-small-up) Set priority', action: 'priority' },
			{ label: `$(${account.enabled ? 'circle-slash' : 'check'}) ${account.enabled ? 'Disable' : 'Enable'} account`, action: 'toggle' },
			{ label: '$(trash) Remove account', action: 'remove' }
		], { title: `${providerName} · ${account.name}` });
		if (!selected) {
			return;
		}
		let next: StoredProviderAccount[] = accounts;
		if (selected.action === 'rename') {
			const name = await vscode.window.showInputBox({ title: 'Account name', value: account.name, ignoreFocusOut: true });
			if (name === undefined || !name.trim()) {
				return;
			}
			next = replaceAccount(accounts, accountId, { ...account, name: name.trim() });
		} else if (selected.action === 'replace') {
			const secret = await this.readSecret(`${providerName} · ${account.name}`);
			if (secret === undefined) {
				return;
			}
			next = replaceAccount(accounts, accountId, { ...account, secret });
		} else if (selected.action === 'priority') {
			const priority = await vscode.window.showInputBox({
				title: 'Account priority',
				value: String(account.priority),
				prompt: 'Lower numbers are attempted first before round-robin peers.',
				validateInput: value => Number.isInteger(Number(value)) && Number(value) >= 0 ? undefined : 'Enter a non-negative integer.'
			});
			if (priority === undefined) {
				return;
			}
			next = replaceAccount(accounts, accountId, { ...account, priority: Number(priority) });
		} else if (selected.action === 'toggle') {
			next = replaceAccount(accounts, accountId, { ...account, enabled: !account.enabled });
		} else if (selected.action === 'remove') {
			const confirmation = await vscode.window.showWarningMessage(`Remove ${account.name}?`, { modal: true }, 'Remove');
			if (confirmation !== 'Remove') {
				return;
			}
			next = accounts.filter(candidate => candidate.id !== accountId);
			this.health.delete(this.healthKey(providerId, accountId));
		}
		await this.writeAccounts(providerId, next);
	}

	private async readSecret(title: string): Promise<string | undefined> {
		const value = await vscode.window.showInputBox({
			title,
			prompt: 'The key is stored only in the operating-system credential vault.',
			password: true,
			ignoreFocusOut: true,
			validateInput: input => input.trim() ? undefined : 'Enter an API key.'
		});
		return value?.trim();
	}

	private async readAccounts(providerId: string): Promise<StoredProviderAccount[]> {
		const stored = await this.context.secrets.get(this.secretKey(providerId));
		if (!stored) {
			return [];
		}
		try {
			const parsed: unknown = JSON.parse(stored);
			if (!Array.isArray(parsed)) {
				return [];
			}
			if (parsed.every(value => typeof value === 'string')) {
				const migrated = parsed
					.filter((secret): secret is string => typeof secret === 'string' && Boolean(secret.trim()))
					.map((secret, index): StoredProviderAccount => ({
						id: `legacy-${index + 1}`,
						name: `Account ${index + 1}`,
						secret,
						enabled: true,
						priority: index,
						createdAt: new Date(index).toISOString()
					}));
				await this.writeAccounts(providerId, migrated);
				return migrated;
			}
			return parsed.filter(isStoredAccount);
		} catch {
			return [];
		}
	}

	private async writeAccounts(providerId: string, accounts: readonly StoredProviderAccount[]): Promise<void> {
		await this.context.secrets.store(this.secretKey(providerId), JSON.stringify(accounts));
		this.changeEmitter.fire();
	}

	private getHealth(providerId: string, accountId: string): RuntimeAccountHealth | undefined {
		const key = this.healthKey(providerId, accountId);
		const health = this.health.get(key);
		if (health?.state === 'cooldown' && health.until && health.until <= Date.now()) {
			this.health.delete(key);
			return undefined;
		}
		return health;
	}

	private healthKey(providerId: string, accountId: string): string {
		return `${providerId}:${accountId}`;
	}

	private secretKey(providerId: string): string {
		return `${SECRET_KEY_PREFIX}${providerId}`;
	}
}

function isStoredAccount(value: unknown): value is StoredProviderAccount {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const account = value as Partial<StoredProviderAccount>;
	return typeof account.id === 'string'
		&& typeof account.name === 'string'
		&& typeof account.secret === 'string'
		&& typeof account.enabled === 'boolean'
		&& typeof account.priority === 'number'
		&& typeof account.createdAt === 'string';
}

function splitSecrets(input: string): string[] {
	return [...new Set(input.split(/[\s,]+/).map(value => value.trim()).filter(Boolean))];
}

function nextPriority(accounts: readonly StoredProviderAccount[]): number {
	return accounts.reduce((highest, account) => Math.max(highest, account.priority), -1) + 1;
}

function replaceAccount(accounts: readonly StoredProviderAccount[], id: string, replacement: StoredProviderAccount): StoredProviderAccount[] {
	return accounts.map(account => account.id === id ? replacement : account);
}
