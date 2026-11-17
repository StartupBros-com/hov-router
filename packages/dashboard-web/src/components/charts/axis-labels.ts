/**
 * Shortens a label to `maxChars` characters by cutting its middle, so names
 * that share a prefix ("synthetic-account-a", "-b") or a suffix stay apart.
 * Counts code points, never splitting a character made of two UTF-16 units.
 */
export function middleEllipsis(label: string, maxChars: number): string {
	const chars = Array.from(label);
	if (chars.length <= maxChars) return label;
	const head = Math.floor((maxChars - 1) / 2);
	const tail = maxChars - 1 - head;
	return `${chars.slice(0, head).join("")}…${chars.slice(-tail).join("")}`;
}

/**
 * Shortens a label to `maxChars` characters by cutting its end, for names that
 * differ at the start, such as model ids. Counts code points like
 * middleEllipsis.
 */
export function endEllipsis(label: string, maxChars: number): string {
	const chars = Array.from(label);
	if (chars.length <= maxChars) return label;
	return `${chars.slice(0, maxChars - 1).join("")}…`;
}

/**
 * On a phone the model charts stand model names upright under their bars: at
 * -45 degrees a name reaches about 0.7 of its length to the left of its bar,
 * past the edge of a phone-width chart. Upright, its length is its depth, and
 * with the charts' 80 px bottom margin a 112 px axis holds about 184 px. 26
 * characters of their 12 px text measure up to about 180 px in Chromium, so
 * every catalogue id fits whole; a longer name is cut at the end, and the
 * tooltip shows it in full.
 */
export const PHONE_MODEL_AXIS_HEIGHT = 112;
const PHONE_MODEL_LABEL_CHARS = 26;

export function phoneModelLabel(value: number | string): string {
	return endEllipsis(String(value), PHONE_MODEL_LABEL_CHARS);
}
