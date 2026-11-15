import type { PillTone } from "../ui/status-pill";
/** Presentation tone of an account status. */
export type StatusTone = "ok" | "warning" | "bad" | "muted";
export const STATUS_PILL_TONE: Record<StatusTone, PillTone> = {
	ok: "success",
	warning: "warning",
	bad: "danger",
	muted: "neutral",
};
