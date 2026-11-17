import { useLayoutEffect, useRef, useState } from "react";

/**
 * The rendered width of the element `ref` is attached to, in whole pixels,
 * kept current with a ResizeObserver. It is 0 until the first layout effect
 * runs (and always 0 in server rendering), so callers supply their own
 * fallback.
 */
export function useElementWidth<T extends HTMLElement>(enabled = true) {
	const ref = useRef<T>(null);
	const [width, setWidth] = useState(0);
	useLayoutEffect(() => {
		if (!enabled) return;
		const el = ref.current;
		if (!el) return;
		setWidth(Math.round(el.getBoundingClientRect().width));
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(([entry]) =>
			setWidth(Math.round(entry.contentRect.width)),
		);
		observer.observe(el);
		return () => observer.disconnect();
	}, [enabled]);
	return { ref, width };
}
