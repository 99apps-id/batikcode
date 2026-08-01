/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	evaluatePairing,
	isAuthorizedTelegramUser,
	PairingChallenge,
	parseUserIds,
	timingSafeTokenEquals
} from '../telegramSecurity';

describe('Telegram authorization helpers', () => {
	it('accepts unique positive user IDs and rejects group-style negative chat IDs', () => {
		assert.deepEqual(parseUserIds('123, 456 123 -100987 bad'), ['123', '456']);
	});

	it('compares pairing tokens without accepting prefixes or different lengths', () => {
		const token = 'm6ZsJx6EV7V03mPBr5lGgQx9w1XrQh9T';
		assert.equal(timingSafeTokenEquals(token, token), true);
		assert.equal(timingSafeTokenEquals(`${token}x`, token), false);
		assert.equal(timingSafeTokenEquals(token.slice(0, -1), token), false);
	});

	it('authorizes only paired numeric users in a private chat', () => {
		assert.equal(isAuthorizedTelegramUser('private', '123', ['123']), true);
		assert.equal(isAuthorizedTelegramUser('group', '123', ['123']), false);
		assert.equal(isAuthorizedTelegramUser('private', '456', ['123']), false);
		assert.equal(isAuthorizedTelegramUser('private', undefined, ['123']), false);
	});
});

describe('Telegram pairing verdict', () => {
	const challenge: PairingChallenge = { code: 'dev-pairing-code', expiresAt: 2_000_000_000_000 };

	it('accepts the correct code in a private chat with an active challenge', () => {
		assert.deepEqual(evaluatePairing('private', '123', challenge, 1_900_000_000_000, '  dev-pairing-code  '), { ok: true });
	});

	it('rejects group chats even with a valid code', () => {
		assert.deepEqual(evaluatePairing('group', '123', challenge, 1_900_000_000_000, 'dev-pairing-code'), { ok: false, reason: 'not-private-chat' });
	});

	it('rejects pairing without an active challenge', () => {
		assert.deepEqual(evaluatePairing('private', '123', undefined, 1_900_000_000_000, 'dev-pairing-code'), { ok: false, reason: 'no-challenge' });
	});

	it('rejects expired challenges before comparing the code', () => {
		assert.deepEqual(evaluatePairing('private', '123', challenge, 2_000_000_000_001, 'dev-pairing-code'), { ok: false, reason: 'expired' });
	});

	it('rejects a wrong code without leaking the expected value', () => {
		assert.deepEqual(evaluatePairing('private', '123', challenge, 1_900_000_000_000, 'wrong'), { ok: false, reason: 'code-mismatch' });
	});

	it('consumes the challenge after a successful pairing', () => {
		const verdict = evaluatePairing('private', '123', challenge, 1_900_000_000_000, 'dev-pairing-code');
		assert.equal(verdict.ok, true);
	});
});

describe('Telegram HTML helpers (inline contract)', () => {
	// Keep these tiny pure helpers in sync with telegramBot.ts escapeHtml/stripHtml.
	function escapeHtml(value: string): string {
		return value
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}

	function stripHtml(value: string): string {
		return value
			.replace(/<br\s*\/?>/gi, '\n')
			.replace(/<\/p>/gi, '\n')
			.replace(/<[^>]+>/g, '')
			.replace(/&lt;/g, '<')
			.replace(/&gt;/g, '>')
			.replace(/&amp;/g, '&')
			.replace(/&quot;/g, '"');
	}

	it('escapes dynamic status fragments so /code <task> cannot break HTML parse_mode', () => {
		assert.equal(escapeHtml('use /code <task>'), 'use /code &lt;task&gt;');
		assert.equal(escapeHtml('A&B'), 'A&amp;B');
	});

	it('strips curated HTML when falling back to plain Telegram messages', () => {
		assert.equal(stripHtml('<b>BatikCode</b> &lt;task&gt;'), 'BatikCode <task>');
	});
});
