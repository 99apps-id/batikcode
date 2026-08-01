/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IAgentConnection } from '../../../../../platform/agentHost/common/agentService.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IShellLaunchConfig } from '../../../../../platform/terminal/common/terminal.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { AgentHostPty } from '../../browser/agentHostPty.js';
import { AgentHostTerminalService } from '../../browser/agentHostTerminalService.js';
import { AhpTerminalCommandSource } from '../../browser/ahpTerminalCommandSource.js';
import { ICreateTerminalOptions, ITerminalChatService, ITerminalInstance, ITerminalService } from '../../browser/terminal.js';
import { ITerminalProfileService } from '../../common/terminal.js';

suite('AgentHostTerminalService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	/**
	 * Stands in for the real terminal instance creation machinery. Mirrors the
	 * real flow closely enough to matter for this suite: `customPtyImplementation`
	 * is invoked synchronously — constructing the pty — before the returned
	 * promise resolves with the terminal instance.
	 */
	class MockTerminalService extends mock<ITerminalService>() {
		readonly createdPtys: AgentHostPty[] = [];

		override async createTerminal(options?: ICreateTerminalOptions): Promise<ITerminalInstance> {
			const config = options?.config as IShellLaunchConfig;
			const instanceId = this.createdPtys.length + 1;
			const pty = config.customPtyImplementation!(instanceId, 0, 0) as AgentHostPty;
			this.createdPtys.push(pty);
			store.add(pty);

			const instanceStore = new DisposableStore();
			const onDisposed = store.add(new Emitter<ITerminalInstance>());
			const onWillData = store.add(new Emitter<string>());
			store.add(instanceStore);
			return {
				instanceId,
				store: instanceStore,
				onDisposed: onDisposed.event,
				onWillData: onWillData.event,
			} as unknown as ITerminalInstance;
		}
	}

	function createService(): { service: AgentHostTerminalService; terminalService: MockTerminalService } {
		const instantiationService = store.add(new TestInstantiationService());
		const terminalService = new MockTerminalService();
		instantiationService.stub(ITerminalService, terminalService);
		instantiationService.stub(ITerminalChatService, new class extends mock<ITerminalChatService>() {
			override registerAhpCommandSource() {
				return { dispose() { } };
			}
			override registerTerminalInstanceWithToolSession() { }
		});
		instantiationService.stub(ITerminalProfileService, new class extends mock<ITerminalProfileService>() { });
		instantiationService.stub(IQuickInputService, new class extends mock<IQuickInputService>() { });

		const service = store.add(instantiationService.createInstance(AgentHostTerminalService));
		return { service, terminalService };
	}

	test('reviveTerminal resolves with the created instance instead of throwing', async () => {
		const { service } = createService();
		const connection = { clientId: 'test-client' } as unknown as IAgentConnection;
		const terminalUri = URI.parse('agenthost-terminal:///revive-test-1');

		const instance = await service.reviveTerminal(connection, terminalUri, 'tool-session-1');

		assert.strictEqual(instance.instanceId, 1);
	});

	test('reviveTerminal connects the AHP command source to the resolved instance, not undefined', async () => {
		const { service } = createService();
		const connection = { clientId: 'test-client' } as unknown as IAgentConnection;
		const terminalUri = URI.parse('agenthost-terminal:///revive-test-2');

		// `customPtyImplementation` runs synchronously while the terminal
		// instance is still being constructed, before `createTerminal()`'s
		// promise resolves. `connect()` must therefore be deferred until the
		// instance is actually available — capture its arguments to prove that.
		const calls: { terminalInstance: ITerminalInstance | undefined }[] = [];
		const originalConnect = AhpTerminalCommandSource.prototype.connect;
		AhpTerminalCommandSource.prototype.connect = function (this: AhpTerminalCommandSource, terminalInstance: ITerminalInstance, pty: AgentHostPty) {
			calls.push({ terminalInstance });
			return originalConnect.call(this, terminalInstance, pty);
		};

		try {
			const instance = await service.reviveTerminal(connection, terminalUri, 'tool-session-2');

			assert.strictEqual(calls.length, 1, 'connect() should be called exactly once');
			assert.strictEqual(calls[0].terminalInstance, instance, 'connect() must receive the resolved terminal instance, not undefined');
		} finally {
			AhpTerminalCommandSource.prototype.connect = originalConnect;
		}
	});
});
