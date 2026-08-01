/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timingSafeEqual } from 'crypto';

export function parseUserIds(value: string): string[] {
	return [...new Set(value.split(/[\s,]+/).map(item => item.trim()).filter(item => /^\d+$/.test(item)))];
}

export function timingSafeTokenEquals(actual: string, expected: string): boolean {
	const actualBytes = Buffer.from(actual);
	const expectedBytes = Buffer.from(expected);
	return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export interface PairingChallenge {
	readonly code: string;
	readonly expiresAt: number;
}

export type PairingRejection =
	| 'not-private-chat'
	| 'no-challenge'
	| 'expired'
	| 'code-mismatch';

export type PairingVerdict =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: PairingRejection };

/**
 * Evaluates a `/pair` submission against the pairing protections:
 * private chat only, an active one-time challenge, an unexpired code, and a
 * timing-safe token comparison. The verdict order matches the enforcement
 * order in the bot so a failed attempt surfaces the most useful message.
 */
export function evaluatePairing(
	chatType: string | undefined,
	userId: string | undefined,
	challenge: PairingChallenge | undefined,
	now: number,
	submittedCode: string
): PairingVerdict {
	if (chatType !== 'private' || !userId) {
		return { ok: false, reason: 'not-private-chat' };
	}
	if (!challenge) {
		return { ok: false, reason: 'no-challenge' };
	}
	if (challenge.expiresAt < now) {
		return { ok: false, reason: 'expired' };
	}
	if (!timingSafeTokenEquals(submittedCode.trim(), challenge.code)) {
		return { ok: false, reason: 'code-mismatch' };
	}
	return { ok: true };
}

/**
 * Authorized commands require a paired numeric Telegram user in a private
 * chat. Legacy group/chat-ID grants are never accepted.
 */
export function isAuthorizedTelegramUser(
	chatType: string | undefined,
	userId: string | undefined,
	allowedUserIds: readonly string[]
): boolean {
	return userId !== undefined && chatType === 'private' && allowedUserIds.includes(userId);
}
