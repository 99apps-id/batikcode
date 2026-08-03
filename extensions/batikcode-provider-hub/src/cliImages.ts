/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { NormalizedChatMessage, NormalizedContentPart } from './providerRouterUtils';

const IMAGE_FILE_EXTENSIONS: Readonly<Record<string, string>> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/jpg': 'jpg',
	'image/gif': 'gif',
	'image/webp': 'webp',
	'image/bmp': 'bmp',
	'image/svg+xml': 'svg'
};

export interface MaterializedPrompt {
	readonly messages: readonly NormalizedChatMessage[];
	/** Number of images written; 0 means the conversation had none. */
	readonly imageCount: number;
	dispose(): Promise<void>;
}

/**
 * Writes attached images to real files and replaces each one with its path.
 *
 * The CLI transports are driven by a text prompt, so base64 bytes cannot reach
 * the model inline — describing the image instead ("[Image: image/png, 4kb]")
 * only invites a confident answer about something never seen. These CLIs are
 * agents that can open files, so a path is something they can act on.
 *
 * Failing to write one image degrades that image alone; the rest of the turn is
 * still sent.
 */
export async function materializeImagesForCli(
	messages: readonly NormalizedChatMessage[],
	directoryFactory: () => Promise<string> = () => fs.promises.mkdtemp(path.join(os.tmpdir(), 'batikcode-image-'))
): Promise<MaterializedPrompt> {
	let directory: string | undefined;
	let written = 0;
	const result: NormalizedChatMessage[] = [];

	for (const message of messages) {
		if (typeof message.content === 'string' || !message.content.some(part => part.type === 'image')) {
			result.push(message);
			continue;
		}
		const content: NormalizedContentPart[] = [];
		for (const part of message.content) {
			if (part.type !== 'image' || !part.data) {
				content.push(part);
				continue;
			}
			try {
				directory ??= await directoryFactory();
				const extension = IMAGE_FILE_EXTENSIONS[part.mimeType ?? ''] ?? 'png';
				const file = path.join(directory, `attachment-${written + 1}.${extension}`);
				await fs.promises.writeFile(file, Buffer.from(part.data, 'base64'));
				written++;
				content.push({
					type: 'text',
					text: `[The user attached an image. Read it from this file before answering: ${file}]`
				});
			} catch {
				content.push(part);
			}
		}
		result.push({ ...message, content });
	}

	return {
		messages: result,
		imageCount: written,
		dispose: async () => {
			if (directory) {
				await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => undefined);
			}
		}
	};
}
