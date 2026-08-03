/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { MotifId, MOTIFS, moodFor, SPECIES, speciesById, SpeciesId } from './pets';

const VIEW_ID = 'batikcode.pet.view';

/**
 * Diagnostics arrive in bursts while a language server catches up, and each one
 * would otherwise repaint the pet. Settling first keeps it from flickering
 * through moods on every keystroke.
 */
const MOOD_SETTLE_MS = 700;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const provider = new PetViewProvider(context.extensionUri);
	let settle: ReturnType<typeof setTimeout> | undefined;

	const scheduleMoodUpdate = () => {
		if (settle) {
			clearTimeout(settle);
		}
		settle = setTimeout(() => provider.updateMood(), MOOD_SETTLE_MS);
	};

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(VIEW_ID, provider),
		vscode.commands.registerCommand('batikcode.pet.choose', () => choosePet()),
		vscode.commands.registerCommand('batikcode.pet.feed', () => provider.feed()),
		// The companion lives in a panel container, and a panel container the
		// workbench has never shown stays hidden from the tab bar — leaving no
		// way to reach the pet at all. This is that way.
		vscode.commands.registerCommand('batikcode.pet.show', () =>
			vscode.commands.executeCommand('workbench.view.extension.batikcode-pet')),
		vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('batikcode.pet')) {
				provider.refresh();
			}
		}),
		// The pet reads the diagnostics language services already publish rather
		// than parsing anything itself, so it reacts correctly in every language.
		vscode.languages.onDidChangeDiagnostics(scheduleMoodUpdate),
		vscode.workspace.onDidSaveTextDocument(() => provider.celebrate()),
		{ dispose: () => settle && clearTimeout(settle) }
	);

	// A webview provider is resolved lazily. Reveal the contributed view at
	// startup so the pet is actually created without requiring the user to open
	// its container first. Keep a disabled pet from changing the saved layout.
	if (vscode.workspace.getConfiguration('batikcode.pet').get<boolean>('enabled', true)) {
		await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
	}

	provider.updateMood();
}

/** Totals every error and warning currently reported across the workspace. */
function countDiagnostics(): { errors: number; warnings: number } {
	let errors = 0;
	let warnings = 0;
	for (const [, diagnostics] of vscode.languages.getDiagnostics()) {
		for (const diagnostic of diagnostics) {
			if (diagnostic.severity === vscode.DiagnosticSeverity.Error) {
				errors++;
			} else if (diagnostic.severity === vscode.DiagnosticSeverity.Warning) {
				warnings++;
			}
		}
	}
	return { errors, warnings };
}

async function choosePet(): Promise<void> {
	const configuration = vscode.workspace.getConfiguration('batikcode.pet');
	const current = configuration.get<string>('species', 'komodo');
	const picked = await vscode.window.showQuickPick(
		SPECIES.map(species => ({
			label: species.label,
			description: species.origin,
			picked: species.id === current,
			id: species.id
		})),
		{ title: 'BatikCode Pet', placeHolder: 'Pick a companion' }
	);
	if (picked) {
		await configuration.update('species', picked.id, vscode.ConfigurationTarget.Global);
	}
}

class PetViewProvider implements vscode.WebviewViewProvider {
	private view: vscode.WebviewView | undefined;

	public constructor(private readonly extensionUri: vscode.Uri) { }

	public resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
		this.refresh();
	}

	/** Nudges the pet into its happy animation. Silently ignored when hidden. */
	public feed(): void {
		void this.view?.webview.postMessage({ type: 'feed' });
	}

	/** A save is worth a brief cheer, then the mood returns to the diagnostics. */
	public celebrate(): void {
		void this.view?.webview.postMessage({ type: 'feed' });
	}

	/**
	 * Pushes the current mood without rebuilding the page, so the pet keeps its
	 * position mid-stroll instead of restarting the walk on every diagnostic.
	 */
	public updateMood(): void {
		// Counting diagnostics is cheap but not free, and a disabled pet has
		// nothing to show for it.
		if (!this.view || !vscode.workspace.getConfiguration('batikcode.pet').get<boolean>('enabled', true)) {
			return;
		}
		const { errors, warnings } = countDiagnostics();
		void this.view.webview.postMessage({ type: 'mood', ...moodFor(errors, warnings) });
	}

	public refresh(): void {
		if (!this.view) {
			return;
		}
		const configuration = vscode.workspace.getConfiguration('batikcode.pet');
		if (!configuration.get<boolean>('enabled', true)) {
			this.view.webview.html = renderResting();
			return;
		}
		this.view.webview.html = renderPet(
			configuration.get<SpeciesId>('species', 'komodo'),
			configuration.get<MotifId>('motif', 'kawung')
		);
		// Replacing the html resets the page, so the mood has to be sent again.
		this.updateMood();
	}
}

function renderPet(speciesId: SpeciesId, motifId: MotifId): string {
	const species = speciesById(speciesId);
	const motif = MOTIFS[motifId] ?? MOTIFS.kawung;
	// A nonce is required because the CSP forbids inline script without one.
	const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
	content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
	body {
		margin: 0;
		height: 100vh;
		overflow: hidden;
		background: var(--vscode-panel-background);
		color: var(--vscode-descriptionForeground);
		font-family: var(--vscode-font-family);
		font-size: var(--vscode-font-size);
	}

	/* The ground carries the same motif as the pet, so the two read as one
	 * scene rather than a sprite pasted onto a background. */
	.ground {
		position: absolute;
		left: 0;
		bottom: 0;
		/* An <svg> is a replaced element, so an absolutely positioned one with
		 * width:auto takes its 300px intrinsic width and ignores right:0 — the
		 * batik stopped partway across the panel no matter how wide it got.
		 * Sizing it explicitly makes the canvas follow the panel. */
		width: 100%;
		height: 34px;
		border-top: 1px solid var(--vscode-panel-border);
		color: ${species.accent};
		opacity: 0.5;
	}

	.stage { position: absolute; inset: 0; }

	/* Two nested animations: the track carries the pet across the panel and
	 * flips it at each end, while the body bobs. Keeping them separate means the
	 * bob survives the horizontal flip instead of being mirrored with it. */
	/* Position is driven from script rather than keyframes: walking, dragging and
	 * settling all read the same coordinate, so releasing the pet continues the
	 * walk from where it was dropped instead of snapping back onto a keyframe. */
	.track {
		position: absolute;
		bottom: 18px;
		left: 0;
		width: 84px;
		height: 84px;
		cursor: grab;
		touch-action: none;
	}

	.track.dragging { cursor: grabbing; }
	.track.dragging .pet { animation: none; }

	.pet {
		width: 100%;
		height: 100%;
		color: ${species.accent};
		animation: bob ${(species.pace / 6).toFixed(2)}s ease-in-out infinite;
		transform-origin: 50% 90%;
	}

	body.happy .pet { animation: cheer 0.5s ease-in-out 3; }

	@keyframes bob {
		0%, 100% { transform: translateY(0) rotate(0deg); }
		50% { transform: translateY(-3px) rotate(-1.5deg); }
	}

	@keyframes cheer {
		0%, 100% { transform: translateY(0) scale(1); }
		40% { transform: translateY(-14px) scale(1.06); }
	}

	.caption {
		position: absolute;
		top: 8px;
		left: 0;
		right: 0;
		text-align: center;
		opacity: 0.65;
	}

	/* The mood line sits with the caption instead of over the pet: a bubble that
	 * follows a walking animal is unreadable, and this is meant to be glanced at. */
	.mood {
		position: absolute;
		top: 26px;
		left: 0;
		right: 0;
		text-align: center;
		font-weight: 600;
		transition: color 200ms ease-out;
	}

	body[data-mood="calm"] .mood { color: var(--vscode-descriptionForeground); }
	body[data-mood="watching"] .mood { color: var(--vscode-editorWarning-foreground); }
	body[data-mood="alert"] .mood { color: var(--vscode-editorError-foreground); }

	/* Errors get a faster, tighter bob — the pet reads as agitated without any
	 * text having to say so. */
	body[data-mood="alert"] .pet { animation-duration: 0.45s; }
	body[data-mood="watching"] .pet { animation-duration: 0.8s; }

	/* The pet is decoration; motion here carries no information, so it stops
	 * entirely rather than degrading. */
	@media (prefers-reduced-motion: reduce) {
		.pet, body.happy .pet { animation: none; }
	}
</style>
</head>
<body>
	<div class="caption">${escapeHtml(species.label)} · ${escapeHtml(species.origin)}</div>
	<div class="mood" id="mood" role="status" aria-live="polite"></div>
	<div class="stage">
		<div class="track">
			<svg class="pet" viewBox="0 0 100 100" aria-label="${escapeHtml(species.label)}">
				<defs>
					<pattern id="motif" width="24" height="24" patternUnits="userSpaceOnUse">
						${motif.tile}
					</pattern>
					<clipPath id="silhouette">${species.body}</clipPath>
				</defs>
				<g fill="${species.coat}">${species.body}</g>
				<g clip-path="url(#silhouette)" opacity="0.5">
					<rect width="100" height="100" fill="url(#motif)"/>
				</g>
				<!-- Markings last, over the batik: an eye or a stripe buried under the
				pattern stops reading as a marking and becomes more texture. -->
				<g fill="${species.accent}" color="${species.accent}">${species.features}</g>
			</svg>
		</div>
	</div>
	<!-- No viewBox: user units are CSS pixels, so the motif tiles across whatever
	width the panel happens to be and every tile keeps its true proportions.
	A fixed viewBox would either stop short of the right edge or stretch the
	kawung circles into ovals as the panel widens. -->
	<svg class="ground" aria-hidden="true">
		<defs>
			<pattern id="groundMotif" width="24" height="24" patternUnits="userSpaceOnUse">
				${motif.tile}
			</pattern>
		</defs>
		<rect width="100%" height="100%" fill="url(#groundMotif)"/>
	</svg>
	<script nonce="${nonce}">
		const moodEl = document.getElementById('mood');
		const track = document.querySelector('.track');
		const pet = document.querySelector('.pet');
		const SIZE = 84;
		const GROUND = 18;
		const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

		// Pixels per second. Species pace is the seconds a full crossing takes,
		// so speed follows the panel width and stays consistent as it resizes.
		const paceSeconds = ${species.pace};
		let x = 12;
		let y = GROUND;
		let direction = 1;
		let dragging = false;
		let grabX = 0;
		let grabY = 0;
		let last = performance.now();

		function maxX() { return Math.max(0, document.body.clientWidth - SIZE); }

		function paint() {
			track.style.left = x + 'px';
			track.style.bottom = y + 'px';
			// Flip by scaling the track, not the pet: the pet carries the bob, and
			// mirroring that would tilt it the wrong way on the return leg.
			track.style.transform = direction < 0 ? 'scaleX(-1)' : 'scaleX(1)';
		}

		function frame(now) {
			const dt = Math.min(0.05, (now - last) / 1000);
			last = now;
			if (!dragging && !reduced) {
				const limit = maxX();
				x += direction * (limit / paceSeconds) * dt;
				if (x <= 0) { x = 0; direction = 1; }
				else if (x >= limit) { x = limit; direction = -1; }
				// Dropped above the ground: fall back to it rather than hovering.
				if (y > GROUND) { y = Math.max(GROUND, y - 220 * dt); }
			}
			paint();
			requestAnimationFrame(frame);
		}

		track.addEventListener('pointerdown', event => {
			dragging = true;
			track.classList.add('dragging');
			track.setPointerCapture(event.pointerId);
			grabX = event.clientX - x;
			grabY = event.clientY - (document.body.clientHeight - y - SIZE);
			event.preventDefault();
		});

		track.addEventListener('pointermove', event => {
			if (!dragging) { return; }
			x = Math.min(maxX(), Math.max(0, event.clientX - grabX));
			const top = Math.min(document.body.clientHeight - SIZE, Math.max(0, event.clientY - grabY));
			y = document.body.clientHeight - top - SIZE;
			paint();
		});

		function endDrag(event) {
			if (!dragging) { return; }
			dragging = false;
			track.classList.remove('dragging');
			try { track.releasePointerCapture(event.pointerId); } catch { }
			// Walk on from wherever it landed, heading away from the nearer wall.
			direction = x < maxX() / 2 ? 1 : -1;
			last = performance.now();
		}

		track.addEventListener('pointerup', endDrag);
		track.addEventListener('pointercancel', endDrag);

		paint();
		requestAnimationFrame(frame);

		window.addEventListener('message', event => {
			const data = event.data;
			if (data?.type === 'mood') {
				document.body.dataset.mood = data.mood;
				moodEl.textContent = data.message;
				return;
			}
			if (data?.type !== 'feed') { return; }
			document.body.classList.remove('happy');
			// Force a reflow so the animation restarts when fed twice in a row.
			void document.body.offsetWidth;
			document.body.classList.add('happy');
		});
	</script>
</body>
</html>`;
}

/** Shown when the pet is switched off, so the panel explains itself. */
function renderResting(): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
	body {
		margin: 0;
		height: 100vh;
		display: flex;
		align-items: center;
		justify-content: center;
		text-align: center;
		background: var(--vscode-panel-background);
		color: var(--vscode-descriptionForeground);
		font-family: var(--vscode-font-family);
		font-size: var(--vscode-font-size);
	}
</style>
</head>
<body>${escapeHtml('The pet is resting. Turn on batikcode.pet.enabled to bring it back.')}</body>
</html>`;
}

function escapeHtml(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
