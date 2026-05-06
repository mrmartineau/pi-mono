/**
 * Copy-on-select extension.
 *
 * Replicates the Amp CLI behaviour: drag to select text in the terminal and
 * the selection is copied to the system clipboard on mouse release. Uses
 * SGR 1006 mouse reporting (enabled via the `setMouseReporting` primitive),
 * a render tap to draw the highlight, and `copyToClipboard` for OSC 52 /
 * native clipboard handoff.
 *
 * Caveat: enabling mouse reporting suppresses native terminal text selection
 * in most terminals. Shift-drag typically passes through to the terminal's
 * own selection in xterm/iTerm2/WezTerm/Kitty, so users retain a fallback.
 *
 * Setup:
 * - `pi -e ./examples/extensions/copy-on-select`
 * - or copy the directory into ~/.pi/agent/extensions/
 */

import { appendFileSync } from "node:fs";
import { copyToClipboard, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { sliceByColumn } from "@mariozechner/pi-tui";

const DEBUG_LOG = process.env.PI_COPY_ON_SELECT_LOG;
function dbg(msg: string): void {
	if (!DEBUG_LOG) return;
	try {
		appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${msg}\n`);
	} catch {
		// Ignore logging errors.
	}
}

interface Point {
	x: number; // 1-indexed column
	y: number; // 1-indexed row
}

interface ParsedMouse {
	button: number;
	x: number;
	y: number;
	press: boolean;
	drag: boolean;
}

const SGR_MOUSE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;
const REVERSE_ON = "\x1b[7m";
const REVERSE_OFF = "\x1b[27m";

function parseMouse(data: string): ParsedMouse | undefined {
	const m = data.match(SGR_MOUSE);
	if (!m) return undefined;
	const button = Number(m[1]);
	return {
		button,
		x: Number(m[2]),
		y: Number(m[3]),
		press: m[4] === "M",
		drag: (button & 32) !== 0,
	};
}

function orderPoints(a: Point, b: Point): [Point, Point] {
	if (a.y < b.y || (a.y === b.y && a.x <= b.x)) return [a, b];
	return [b, a];
}

function extractSelection(lines: string[], startPoint: Point, endPoint: Point): string {
	const [s, e] = orderPoints(startPoint, endPoint);
	const startRow = Math.max(0, s.y - 1);
	const endRow = Math.min(lines.length - 1, e.y - 1);
	if (startRow > endRow) return "";

	const startCol = Math.max(0, s.x - 1);
	const endCol = Math.max(0, e.x);

	if (startRow === endRow) {
		const line = lines[startRow] ?? "";
		return line.slice(startCol, endCol);
	}

	const firstLine = (lines[startRow] ?? "").slice(startCol);
	const middle = lines.slice(startRow + 1, endRow);
	const lastLine = (lines[endRow] ?? "").slice(0, endCol);
	return [firstLine, ...middle, lastLine].join("\n");
}

function highlightLine(line: string, width: number, fromCol: number, toCol: number): string {
	if (toCol <= fromCol) return line;
	const before = sliceByColumn(line, 0, fromCol);
	const middle = sliceByColumn(line, fromCol, toCol - fromCol);
	const after = sliceByColumn(line, toCol, Math.max(0, width - toCol));
	return before + REVERSE_ON + middle + REVERSE_OFF + after;
}

function buildTap(startPoint: Point, endPoint: Point): (lines: string[], width: number) => string[] {
	const [s, e] = orderPoints(startPoint, endPoint);
	const startRow = s.y - 1;
	const endRow = e.y - 1;
	const startCol = Math.max(0, s.x - 1);
	const endCol = Math.max(0, e.x);

	return (lines, width) => {
		if (startRow < 0 || startRow >= lines.length) return lines;
		const out = lines.slice();
		const lastRow = Math.min(endRow, lines.length - 1);

		if (startRow === lastRow) {
			out[startRow] = highlightLine(lines[startRow] ?? "", width, startCol, endCol);
			return out;
		}

		out[startRow] = highlightLine(lines[startRow] ?? "", width, startCol, width);
		for (let row = startRow + 1; row < lastRow; row++) {
			out[row] = highlightLine(lines[row] ?? "", width, 0, width);
		}
		out[lastRow] = highlightLine(lines[lastRow] ?? "", width, 0, endCol);
		return out;
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("no-copy-on-select", {
		description: "Disable the copy-on-select extension",
		type: "boolean",
		default: false,
	});

	let unsubscribeInput: (() => void) | undefined;
	let active = false;
	let pressPoint: Point | undefined;
	let currentPoint: Point | undefined;

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		if (pi.getFlag("no-copy-on-select") === true) return;

		ctx.ui.setMouseReporting(true);
		active = true;
		dbg("session_start: mouse reporting enabled");

		const clearHighlight = () => {
			pressPoint = undefined;
			currentPoint = undefined;
			ctx.ui.setRenderTap(undefined);
		};

		const updateHighlight = () => {
			if (!pressPoint || !currentPoint) return;
			ctx.ui.setRenderTap(buildTap(pressPoint, currentPoint));
		};

		unsubscribeInput = ctx.ui.onTerminalInput((data) => {
			if (!active) return undefined;
			const mouse = parseMouse(data);
			if (!mouse) return undefined;

			dbg(`mouse: button=${mouse.button} x=${mouse.x} y=${mouse.y} press=${mouse.press} drag=${mouse.drag}`);

			// Skip wheel events (button & 64).
			if ((mouse.button & 64) !== 0) return undefined;
			// Track only the left mouse button.
			const baseButton = mouse.button & 3;
			if (baseButton !== 0) return undefined;

			if (mouse.press && !mouse.drag) {
				// Button down — start a fresh selection.
				pressPoint = { x: mouse.x, y: mouse.y };
				currentPoint = pressPoint;
				ctx.ui.setRenderTap(undefined);
			} else if (mouse.press && mouse.drag) {
				// Drag motion — extend the selection and repaint.
				if (!pressPoint) return undefined;
				currentPoint = { x: mouse.x, y: mouse.y };
				updateHighlight();
			} else if (!mouse.press) {
				// Release — copy and clear.
				const start = pressPoint;
				const end: Point = { x: mouse.x, y: mouse.y };
				clearHighlight();

				if (!start) return undefined;
				if (start.x === end.x && start.y === end.y) return undefined;

				const text = extractSelection(ctx.ui.getRenderedLines(), start, end).trim();
				dbg(`release: start=${start.x},${start.y} end=${end.x},${end.y} text=${JSON.stringify(text.slice(0, 80))}`);
				if (text.length === 0) return undefined;

				void copyToClipboard(text)
					.then(() => {
						const summary = text.length > 40 ? `${text.slice(0, 40).replace(/\s+/g, " ")}…` : text;
						ctx.ui.notify(`Copied: ${summary}`, "info");
					})
					.catch((err) => {
						ctx.ui.notify(`Copy failed: ${err instanceof Error ? err.message : String(err)}`, "error");
					});
			}

			return undefined;
		});
	});

	pi.on("session_shutdown", () => {
		if (unsubscribeInput) {
			unsubscribeInput();
			unsubscribeInput = undefined;
		}
		active = false;
		pressPoint = undefined;
		currentPoint = undefined;
	});
}
