import type { ComboFamilyAssignment } from "@better-ccflare/types";
import type { PillTone } from "../ui/status-pill";

/** Managed routing is the active, product-level mode; Manual is the default. */
export function membershipModeTone(
	mode: ComboFamilyAssignment["membership_mode"],
): PillTone {
	return mode === "managed" ? "primary" : "neutral";
}

export function confidenceTone(highConfidence: boolean): PillTone {
	return highConfidence ? "success" : "warning";
}
