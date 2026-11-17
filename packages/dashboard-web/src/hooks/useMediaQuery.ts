import { useEffect, useState } from "react";

function matches(query: string): boolean {
	if (
		typeof window === "undefined" ||
		typeof window.matchMedia !== "function"
	) {
		return false;
	}
	return window.matchMedia(query).matches;
}

/**
 * Tracks a CSS media query. The dashboard is client-rendered, so the first
 * render already reads the real value instead of flashing a wrong layout.
 * Returns false where matchMedia is unavailable.
 */
export function useMediaQuery(query: string): boolean {
	const [value, setValue] = useState(() => matches(query));

	useEffect(() => {
		if (
			typeof window === "undefined" ||
			typeof window.matchMedia !== "function"
		) {
			return;
		}
		const list = window.matchMedia(query);
		const onChange = () => setValue(list.matches);
		onChange();
		list.addEventListener("change", onChange);
		return () => list.removeEventListener("change", onChange);
	}, [query]);

	return value;
}
