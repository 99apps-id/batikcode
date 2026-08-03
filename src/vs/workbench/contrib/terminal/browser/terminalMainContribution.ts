/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../../../../base/common/async.js';
import { Event } from '../../../../base/common/event.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ITerminalEditorService, ITerminalGroupService, ITerminalInstanceService, ITerminalService, terminalEditorId } from './terminal.js';
import { parseTerminalUri } from './terminalUri.js';
import { terminalStrings } from '../common/terminalStrings.js';
import { IEditorResolverService, RegisteredEditorPriority } from '../../../services/editor/common/editorResolverService.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { ILifecycleService, LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IEmbedderTerminalService } from '../../../services/terminal/common/embedderTerminalService.js';

/**
 * The main contribution for the terminal contrib. This contains calls to other components necessary
 * to set up the terminal but don't need to be tracked in the long term (where TerminalService would
 * be more relevant).
 */
export class TerminalMainContribution extends Disposable implements IWorkbenchContribution {
	static ID = 'terminalMain';

	constructor(
		@IEditorResolverService editorResolverService: IEditorResolverService,
		@IEmbedderTerminalService embedderTerminalService: IEmbedderTerminalService,
		@IWorkbenchEnvironmentService workbenchEnvironmentService: IWorkbenchEnvironmentService,
		@ILabelService labelService: ILabelService,
		@ILifecycleService lifecycleService: ILifecycleService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@ITerminalService terminalService: ITerminalService,
		@ITerminalEditorService terminalEditorService: ITerminalEditorService,
		@ITerminalGroupService terminalGroupService: ITerminalGroupService,
		@ITerminalInstanceService terminalInstanceService: ITerminalInstanceService
	) {
		super();

		this._init(
			editorResolverService,
			embedderTerminalService,
			workbenchEnvironmentService,
			labelService,
			lifecycleService,
			layoutService,
			terminalService,
			terminalEditorService,
			terminalGroupService,
			terminalInstanceService
		);
	}

	private async _init(
		editorResolverService: IEditorResolverService,
		embedderTerminalService: IEmbedderTerminalService,
		workbenchEnvironmentService: IWorkbenchEnvironmentService,
		labelService: ILabelService,
		lifecycleService: ILifecycleService,
		layoutService: IWorkbenchLayoutService,
		terminalService: ITerminalService,
		terminalEditorService: ITerminalEditorService,
		terminalGroupService: ITerminalGroupService,
		terminalInstanceService: ITerminalInstanceService
	) {
		// IMPORTANT: This listener needs to be set up before the workbench is ready to support
		// embedder terminals.
		this._register(embedderTerminalService.onDidCreateTerminal(async embedderTerminal => {
			const terminal = await terminalService.createTerminal({
				config: embedderTerminal,
				location: TerminalLocation.Panel,
				skipContributedProfileCheck: true,
			});
			terminalService.setActiveInstance(terminal);
			await terminalService.revealActiveTerminal();
		}));

		this._register(layoutService.onDidChangePartVisibility(e => {
			if (e.partId === Parts.PANEL_PART && e.visible) {
				terminalGroupService.showPanel(false).catch(onUnexpectedError);
			}
		}));

		await lifecycleService.when(LifecyclePhase.Restored);

		// Register terminal editors
		this._register(editorResolverService.registerEditor(
			`${Schemas.vscodeTerminal}:/**`,
			{
				id: terminalEditorId,
				label: terminalStrings.terminal,
				priority: RegisteredEditorPriority.exclusive
			},
			{
				canSupportResource: uri => uri.scheme === Schemas.vscodeTerminal,
				singlePerResource: true
			},
			{
				createEditorInput: async ({ resource, options }) => {
					let instance = terminalService.getInstanceFromResource(resource);
					if (instance) {
						const sourceGroup = terminalGroupService.getGroupForInstance(instance);
						sourceGroup?.removeInstance(instance);
					} else { // Terminal from a different window
						const terminalIdentifier = parseTerminalUri(resource);
						if (!terminalIdentifier.instanceId) {
							throw new Error('Terminal identifier without instanceId');
						}

						const primaryBackend = terminalService.getPrimaryBackend();
						if (!primaryBackend) {
							throw new Error('No terminal primary backend');
						}

						const attachPersistentProcess = await primaryBackend.requestDetachInstance(terminalIdentifier.workspaceId, terminalIdentifier.instanceId);
						if (!attachPersistentProcess) {
							throw new Error('No terminal persistent process to attach');
						}
						instance = terminalInstanceService.createInstance({ attachPersistentProcess }, TerminalLocation.Editor);
					}

					const resolvedResource = terminalEditorService.resolveResource(instance);
					const editor = terminalEditorService.getInputFromResource(resolvedResource);
					return {
						editor,
						options: {
							...options,
							pinned: true,
							forceReload: true,
							override: terminalEditorId
						}
					};
				}
			}
		));

		// Register a resource formatter for terminal URIs
		this._register(labelService.registerFormatter({
			scheme: Schemas.vscodeTerminal,
			formatting: {
				label: '${path}',
				separator: ''
			}
		}));

		// Have a live shell waiting the first time the panel is opened, instead of
		// paying for pty host startup at that moment.
		//
		// Keyed to Eventually, and deliberately not awaited. A contribution that
		// blocks inside a phase holds that phase open, and the pty host does not
		// launch until the Restored phase has finished — so awaiting a terminal
		// from inside Restored leaves both sides waiting and no terminal ever
		// appears, which is exactly the hang this replaces.
		lifecycleService.when(LifecyclePhase.Eventually).then(async () => {
			try {
				// BatikCode: the startup terminal is a local-window convenience only.
				// In a remote window the shell lives on the remote host and depends on
				// the remote agent host being ready; force-creating one here would
				// leave an empty, non-functional terminal (and force the panel open)
				// whenever that connection is unavailable.
				if (workbenchEnvironmentService.remoteAuthority) {
					return;
				}

				// The startup terminal can fire before the (still-activating) extension
				// host has registered terminal process support; calling createTerminal
				// at that point throws "Could not create terminal when process support
				// is not registered" and leaves the panel empty. Wait for support to be
				// registered (capped), and skip silently if it never arrives — the
				// user can still open a terminal manually once the host is ready.
				if (!terminalService.isProcessSupportRegistered) {
					await Promise.race([
						Event.toPromise(terminalService.onDidRegisterProcessSupport),
						timeout(15_000)
					]);
					if (!terminalService.isProcessSupportRegistered) {
						return;
					}
				}

				// A tab restored from a crashed session can come back as an instance
				// with no process behind it (processId === undefined). Picking such a
				// husk would show an empty panel and never start the pty host, so only
				// reuse an instance that actually has a live process and create a
				// fresh one otherwise.
				const liveInstance = terminalService.activeInstance?.processId !== undefined
					? terminalService.activeInstance
					: terminalService.instances.find(instance => instance.processId !== undefined);
				const terminal = liveInstance
					?? await terminalService.createTerminal({ location: TerminalLocation.Panel });
				terminalService.setActiveInstance(terminal);
				await terminalGroupService.showPanel(false);
			} catch (error) {
				// A shell that cannot start is worth reporting, but it must not take
				// the rest of the workbench down with it.
				onUnexpectedError(error);
			}
		});
	}
}
