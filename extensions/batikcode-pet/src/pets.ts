/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The companions and the batik they wear.
 *
 * Everything is inline SVG built from theme tokens rather than image assets:
 * the webview runs under a strict CSP that blocks external hosts, and a pet
 * drawn from `currentColor` follows the user's theme instead of fighting it.
 */

export type SpeciesId = 'komodo' | 'orangutan' | 'cendrawasih' | 'harimau';
export type MotifId = 'kawung' | 'parang' | 'polos';

export interface Species {
	readonly id: SpeciesId;
	readonly label: string;
	/** Where the animal actually lives — shown when picking. */
	readonly origin: string;
	/** Body colour; the batik overlay is drawn on top of it. */
	readonly coat: string;
	readonly accent: string;
	/**
	 * The silhouette, inside a 100×100 viewBox standing on y~88.
	 *
	 * Recognition lives in the outline — the run of head into back into tail —
	 * so each animal is traced as a contour rather than assembled from ovals.
	 */
	readonly body: string;
	/**
	 * Markings drawn over the batik in the accent colour: an eye, a beak, the
	 * stripes. Small, but they are what turns a shape into a specific animal.
	 */
	readonly features: string;
	/** Seconds for one full walk cycle. Heavier animals move slower. */
	readonly pace: number;
}

/** A seamless 24×24 batik tile, tinted by the species accent at low opacity. */
export const MOTIFS: Readonly<Record<MotifId, { readonly label: string; readonly tile: string }>> = {
	kawung: {
		label: 'Kawung',
		tile: `<g fill="none" stroke="currentColor" stroke-width="1">
			<ellipse cx="12" cy="12" rx="6" ry="5"/><ellipse cx="12" cy="12" rx="5" ry="6"/>
			<ellipse cx="0" cy="0" rx="6" ry="5"/><ellipse cx="24" cy="0" rx="6" ry="5"/>
			<ellipse cx="0" cy="24" rx="6" ry="5"/><ellipse cx="24" cy="24" rx="6" ry="5"/>
			<circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/>
		</g>`
	},
	parang: {
		label: 'Parang',
		tile: `<g fill="none" stroke="currentColor" stroke-width="1.1">
			<path d="M-4 20 Q4 10 12 20 Q20 30 28 20"/>
			<path d="M-4 8 Q4 -2 12 8 Q20 18 28 8"/>
		</g>`
	},
	polos: {
		label: 'Plain',
		tile: ''
	}
};

export const SPECIES: readonly Species[] = [
	{
		id: 'komodo',
		label: 'Komodo',
		origin: 'Nusa Tenggara',
		coat: '#7d8a5c',
		accent: '#3f4a2a',
		pace: 5.5,
		// Low slung, long snout, heavy tail carried behind — a monitor lizard is
		// read almost entirely from how far it stretches horizontally.
		body: `
			<path d="M30 62 Q17 66 3 53 Q5 70 28 71 Z"/>
			<path d="M97 63 Q90 55 78 52 Q60 46 44 50 Q32 53 27 60 Q25 67 34 71 Q50 77 66 76 Q82 74 92 69 Q98 66 97 63 Z"/>
			<path d="M71 73 Q75 81 71 88 L63 88 Q66 80 63 73 Z"/>
			<path d="M43 74 Q47 82 43 89 L35 89 Q38 81 35 74 Z"/>
			<ellipse cx="67" cy="88" rx="7" ry="2.6"/>
			<ellipse cx="39" cy="89" rx="7" ry="2.6"/>`,
		features: `
			<circle cx="85" cy="59" r="2.3"/>
			<path d="M97 64 Q99 64 100 63" stroke-width="1.4" fill="none" stroke="currentColor"/>`
	},
	{
		id: 'orangutan',
		label: 'Orangutan',
		origin: 'Kalimantan & Sumatra',
		coat: '#b4622f',
		accent: '#6d3316',
		pace: 7,
		// Facing us, because the two traits that name this animal only read from
		// the front: a face far wider than it is tall from the cheek flanges, and
		// arms that hang past the feet. The arms are held clear of a deliberately
		// narrow torso — touching it, they merge into one blob and the span, which
		// is the whole point, disappears.
		body: `
			<path d="M50 10 Q72 10 79 24 Q83 34 76 41 Q66 48 50 48 Q34 48 24 41 Q17 34 21 24 Q28 10 50 10 Z"/>
			<path d="M50 46 Q62 48 65 60 Q67 72 62 80 L38 80 Q33 72 35 60 Q38 48 50 46 Z"/>
			<path d="M37 50 Q22 55 16 70 Q11 84 15 92 L23 90 Q20 80 24 70 Q29 58 40 55 Z"/>
			<path d="M63 50 Q78 55 84 70 Q89 84 85 92 L77 90 Q80 80 76 70 Q71 58 60 55 Z"/>
			<ellipse cx="19" cy="92" rx="6" ry="3.4"/>
			<ellipse cx="81" cy="92" rx="6" ry="3.4"/>
			<path d="M41 78 Q44 86 41 92 L34 92 Q37 85 35 78 Z"/>
			<path d="M59 78 Q56 86 59 92 L66 92 Q63 85 65 78 Z"/>`,
		features: `
			<ellipse cx="50" cy="30" rx="13" ry="15" opacity="0.32"/>
			<circle cx="44" cy="26" r="2.2"/>
			<circle cx="56" cy="26" r="2.2"/>
			<path d="M45 39 Q50 43 55 39" stroke-width="1.9" fill="none" stroke="currentColor" stroke-linecap="round"/>`
	},
	{
		id: 'cendrawasih',
		label: 'Cendrawasih',
		origin: 'Papua',
		coat: '#d8a12a',
		accent: '#9a2f2f',
		pace: 4,
		// A small bird carrying an absurd tail. Three things have to hold or it
		// turns into a duck: a head much smaller than the body, a neck to carry
		// it, and a slender beak level with the ground rather than tipped up.
		body: `
			<path d="M52 50 Q76 47 91 30 Q97 22 95 17 Q85 35 66 44 Q57 48 52 50 Z"/>
			<path d="M54 56 Q78 57 94 45 Q100 40 99 35 Q88 50 67 56 Q59 58 54 56 Z"/>
			<path d="M34 42 Q23 47 23 57 Q24 67 34 71 Q45 75 54 71 Q64 66 64 56 Q64 46 54 42 Q44 38 34 42 Z"/>
			<path d="M36 45 Q30 38 31 30 Q32 24 37 23 Q42 24 42 31 Q42 39 42 44 Z"/>
			<circle cx="37" cy="21" r="7.5"/>
			<path d="M31 20 Q22 21 13 24 Q22 25 30 24 Z"/>
			<path d="M42 62 Q54 59 60 52 Q56 65 44 68 Z"/>
			<rect x="38" y="70" width="3.2" height="16" rx="1.6"/>
			<rect x="49" y="70" width="3.2" height="16" rx="1.6"/>
			<ellipse cx="39" cy="88" rx="6.5" ry="2.6"/>
			<ellipse cx="50" cy="88" rx="6.5" ry="2.6"/>`,
		features: `
			<circle cx="39" cy="19" r="2"/>
			<path d="M31 20 Q22 21 13 24 Q22 25 30 24 Z" opacity="0.6"/>`
	},
	{
		id: 'harimau',
		label: 'Harimau Sumatera',
		origin: 'Sumatra',
		coat: '#d8853a',
		accent: '#3a2412',
		pace: 4.5,
		// A cat in profile: deep chest, dipped back, high shoulder, and a tail
		// that curls up rather than trailing — that curl is what separates it
		// from the komodo at this size.
		body: `
			<path d="M23 60 Q11 58 5 46 Q2 37 7 33 Q6 44 14 52 Q19 57 25 57 Z"/>
			<path d="M26 58 Q33 49 48 47 Q63 45 74 50 Q83 54 85 62 Q85 71 74 74 Q56 78 41 76 Q28 73 26 65 Z"/>
			<path d="M72 55 Q70 43 79 38 Q90 34 95 42 Q98 50 94 57 Q88 63 79 61 Z"/>
			<path d="M76 40 L74 29 L84 36 Z"/>
			<path d="M94 41 L96 30 L88 36 Z"/>
			<path d="M69 74 Q73 82 69 89 L61 89 Q64 81 61 74 Z"/>
			<path d="M38 76 Q42 83 38 90 L30 90 Q33 82 30 76 Z"/>
			<ellipse cx="65" cy="89" rx="7" ry="2.8"/>
			<ellipse cx="34" cy="90" rx="7" ry="2.8"/>`,
		features: `
			<circle cx="86" cy="47" r="2.2"/>
			<g stroke="currentColor" stroke-width="2.4" stroke-linecap="round" fill="none">
				<path d="M62 49 Q60 56 61 63"/>
				<path d="M52 48 Q50 56 51 64"/>
				<path d="M42 49 Q40 56 41 64"/>
				<path d="M32 53 Q31 58 32 63"/>
			</g>`
	}
];

export function speciesById(id: string): Species {
	return SPECIES.find(s => s.id === id) ?? SPECIES[0];
}

/**
 * What the pet is reacting to. Derived from the diagnostics the language
 * services already produce — the pet never parses code itself, so it stays
 * correct for every language without knowing any of them.
 */
export type Mood = 'calm' | 'watching' | 'alert' | 'happy';

export interface MoodState {
	readonly mood: Mood;
	readonly message: string;
}

export function moodFor(errors: number, warnings: number): MoodState {
	if (errors > 0) {
		return {
			mood: 'alert',
			message: errors === 1 ? '1 error' : `${errors} errors`
		};
	}
	if (warnings > 0) {
		return {
			mood: 'watching',
			message: warnings === 1 ? '1 warning' : `${warnings} warnings`
		};
	}
	return { mood: 'calm', message: 'all clear' };
}
