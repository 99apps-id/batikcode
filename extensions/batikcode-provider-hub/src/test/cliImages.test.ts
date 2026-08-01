/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { materializeImagesForCli } from '../cliImages';
import type { NormalizedChatMessage } from '../providerRouterUtils';

/** A one-pixel PNG, base64 — the smallest thing that is genuinely an image. */
const PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function userTurn(...content: NormalizedChatMessage['content'] extends string ? never[] : { type: string; text?: string; mimeType?: string; data?: string }[]): NormalizedChatMessage {
	return { role: 'user', content } as NormalizedChatMessage;
}

describe('CLI image attachments', () => {
	it('writes each image to a file and points the CLI at its path', async () => {
		const materialized = await materializeImagesForCli([
			userTurn({ type: 'text', text: 'what is in this?' }, { type: 'image', mimeType: 'image/png', data: PIXEL_PNG })
		]);
		try {
			const parts = materialized.messages[0].content as readonly { type: string; text?: string }[];
			const reference = parts[1].text ?? '';
			const file = reference.slice(reference.indexOf(': ') + 2, -1);

			assert.deepEqual(
				{
					imageCount: materialized.imageCount,
					keptTheQuestion: parts[0].text,
					noImagePartLeft: parts.every(part => part.type === 'text'),
					extension: path.extname(file),
					bytesOnDisk: fs.readFileSync(file).length
				},
				{
					imageCount: 1,
					keptTheQuestion: 'what is in this?',
					noImagePartLeft: true,
					extension: '.png',
					bytesOnDisk: Buffer.from(PIXEL_PNG, 'base64').length
				}
			);
		} finally {
			await materialized.dispose();
		}
	});

	it('removes the files it wrote once the turn is over', async () => {
		const materialized = await materializeImagesForCli([
			userTurn({ type: 'image', mimeType: 'image/jpeg', data: PIXEL_PNG })
		]);
		const reference = (materialized.messages[0].content as readonly { text?: string }[])[0].text ?? '';
		const file = reference.slice(reference.indexOf(': ') + 2, -1);
		assert.equal(fs.existsSync(file), true);

		await materialized.dispose();
		assert.equal(fs.existsSync(file), false);
	});

	it('leaves image-free conversations untouched and writes nothing', async () => {
		const messages: NormalizedChatMessage[] = [
			{ role: 'system', content: 'be brief' },
			userTurn({ type: 'text', text: 'hello' })
		];
		const materialized = await materializeImagesForCli(messages, () => {
			throw new Error('must not create a directory when there is no image');
		});
		assert.deepEqual(
			{ imageCount: materialized.imageCount, messages: materialized.messages },
			{ imageCount: 0, messages }
		);
		await materialized.dispose();
	});

	it('keeps the rest of the turn when an image cannot be written', async () => {
		const materialized = await materializeImagesForCli(
			[userTurn({ type: 'text', text: 'still ask this' }, { type: 'image', mimeType: 'image/png', data: PIXEL_PNG })],
			async () => path.join(os.tmpdir(), 'batikcode-missing', 'nope')
		);
		const parts = materialized.messages[0].content as readonly { type: string; text?: string }[];
		assert.deepEqual(
			{ imageCount: materialized.imageCount, first: parts[0].text, second: parts[1].type },
			{ imageCount: 0, first: 'still ask this', second: 'image' }
		);
		await materialized.dispose();
	});
});
