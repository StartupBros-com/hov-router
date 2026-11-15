import { type ReactNode, Suspense } from "react";
import { PAGE_META, type PageKey } from "../lib/page-meta";
import { PageHeader } from "./ui/page-header";
import { LoadingState } from "./ui/state";

/** The page's own header, titled from page meta, with optional actions. */
export function RoutePageHeader({
	page,
	actions,
}: {
	page: PageKey;
	actions?: ReactNode;
}) {
	const { title, description } = PAGE_META[page];
	return (
		<PageHeader title={title} description={description} actions={actions} />
	);
}

/** The header above a page-size loading state, for a page whose data or code has not arrived. */
export function PageLoading({ page }: { page: PageKey }) {
	return (
		<div className="space-y-4">
			<RoutePageHeader page={page} />
			<LoadingState label={`Loading ${PAGE_META[page].title.toLowerCase()}`} />
		</div>
	);
}

/** Shows the page's header and loading state while a lazily loaded page's code downloads. */
export function LazyPage({
	page,
	children,
}: {
	page: PageKey;
	children: ReactNode;
}) {
	return <Suspense fallback={<PageLoading page={page} />}>{children}</Suspense>;
}
