/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IAgentHostEnablementService } from '../../../../../platform/agentHost/common/agentHostEnablementService.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { EditorRemoteAgentHostServiceClient } from '../../browser/editorRemoteAgentHostServiceClient.js';
import { IRemoteAgentConnection, IRemoteAgentService } from '../../../remote/common/remoteAgentService.js';

suite('EditorRemoteAgentHostServiceClient', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('waits for the remote management connection before connecting the Agent Host protocol', async () => {
		const managementConnectionReady = new DeferredPromise<number>();
		let protocolConnectCalls = 0;
		let ownedTransport: { dispose(): void } | undefined;
		const protocolClient = {
			clientId: 'test-client',
			onDidClose: Event.None,
			connect: async () => { protocolConnectCalls++; },
			dispose: () => ownedTransport?.dispose(),
		};
		const connection = {
			remoteAuthority: 'ssh-remote+test',
			getChannel: () => ({}),
			getInitialConnectionTimeMs: () => managementConnectionReady.p,
		} as unknown as IRemoteAgentConnection;
		const remoteAgentService = {
			getConnection: () => connection,
		} as unknown as IRemoteAgentService;
		const enablementService = { enabled: true } as unknown as IAgentHostEnablementService;
		const instantiationService = {
			createInstance: (_ctor: unknown, _address: string, transport: { dispose(): void }) => {
				ownedTransport = transport;
				return protocolClient;
			},
		} as unknown as IInstantiationService;

		disposables.add(new EditorRemoteAgentHostServiceClient(
			remoteAgentService,
			enablementService,
			instantiationService,
			new NullLogService(),
		));

		await Promise.resolve();
		assert.strictEqual(protocolConnectCalls, 0);

		managementConnectionReady.complete(125);
		await Promise.resolve();
		assert.strictEqual(protocolConnectCalls, 1);
	});
});
