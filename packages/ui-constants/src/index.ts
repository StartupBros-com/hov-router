// Chart series colours. Each is a theme token from the dashboard's
// globals.css, so light and dark each get a shade that keeps 3:1 against the
// card. They are only valid where CSS resolves var(): SVG attributes, gradient
// stops and style props.
export const COLORS = {
	primary: "var(--chart-primary)",
	success: "var(--chart-success)",
	warning: "var(--chart-warning)",
	error: "var(--chart-error)",
	blue: "var(--chart-blue)",
	purple: "var(--chart-purple)",
	pink: "var(--chart-pink)",
	indigo: "var(--chart-indigo)",
	cyan: "var(--chart-cyan)",
	teal: "var(--chart-teal)",
	orange: "var(--chart-orange)",
} as const;

// Chart color sequence for multi-series charts
export const CHART_COLORS = [
	COLORS.primary,
	COLORS.blue,
	COLORS.purple,
	COLORS.pink,
	COLORS.success,
] as const;

// Time range options for analytics
export type TimeRange = "1h" | "6h" | "24h" | "7d" | "30d";

export const TIME_RANGES: Record<TimeRange, string> = {
	"1h": "Last Hour",
	"6h": "Last 6 Hours",
	"24h": "Last 24 Hours",
	"7d": "Last 7 Days",
	"30d": "Last 30 Days",
} as const;

// Chart dimensions
export const CHART_HEIGHTS = {
	small: 250,
	medium: 300,
	large: 400,
} as const;

// Chart tooltips use the popover colours in both themes. The three keys stay
// so existing callers keep compiling; they no longer differ.
const TOOLTIP_STYLE = {
	backgroundColor: "var(--popover)",
	border: "1px solid var(--border)",
	borderRadius: "var(--radius)",
	color: "var(--popover-foreground)",
} as const;

export const CHART_TOOLTIP_STYLE = {
	default: TOOLTIP_STYLE,
	success: TOOLTIP_STYLE,
	dark: TOOLTIP_STYLE,
} as const;

// Chart common properties. gridClassName styles CartesianGrid lines through
// CSS; the rest are for props that take a colour. Recharts writes its own
// literal colours wherever a chart leaves one unset (grid #ccc, axes #666,
// dot and pie outlines #fff), so charts pass these instead.
export const CHART_PROPS = {
	strokeDasharray: "3 3",
	gridClassName: "stroke-(--chart-grid)",
	gridStroke: "var(--chart-grid)",
	// Axis lines, ticks, tick text and axis labels.
	axisStroke: "var(--chart-axis)",
	// The hover line on line and area charts.
	cursorStroke: "var(--border)",
	// The hover block behind bars.
	cursorFill: "var(--muted)",
	// Outlines that separate a mark from the card: pie sectors and dots.
	surfaceStroke: "var(--card)",
} as const;

// API and data refresh intervals (in milliseconds)
export const REFRESH_INTERVALS = {
	default: 30000, // 30 seconds
	fast: 10000, // 10 seconds
	slow: 60000, // 1 minute
} as const;

// API timeout
export const API_TIMEOUT = 30000; // 30 seconds

// React Query configuration
export const QUERY_CONFIG = {
	staleTime: 10000, // Consider data stale after 10 seconds
} as const;

// API default limits
export const API_LIMITS = {
	requestsDetail: 50,
	requestsSummary: 50,
} as const;
