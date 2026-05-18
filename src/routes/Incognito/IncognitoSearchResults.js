// Full-viewport grid of IncognitoCards with infinite scroll.
//
// Data flow: `useIncognitoSearch` hands back the first page (cache-seeded
// or fetched), plus a `loadMore()` that appends the next page. We wire an
// IntersectionObserver to a sentinel div at the bottom of the grid —
// whenever it scrolls into view we trigger another fetch, stopping when
// `hasMore` flips false. This keeps the grid reading as one continuous
// stream of results instead of a capped single page.

const React = require('react');
const classnames = require('classnames');
const useIncognitoSearch = require('./useIncognitoSearch');
const IncognitoCard = require('./IncognitoCard');
const styles = require('./styles');

function IncognitoSearchResults({ query }) {
    const { results, loading, loadingMore, stale, refreshFailed, hasMore, loadMore } = useIncognitoSearch(query);
    const sentinelRef = React.useRef(null);

    // IntersectionObserver → loadMore. We reuse a single observer that
    // watches the sentinel; `loadMore` itself guards against double-fire.
    React.useEffect(() => {
        if (!sentinelRef.current) return undefined;
        if (!hasMore) return undefined;
        if (typeof IntersectionObserver === 'undefined') return undefined;

        const observer = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (entry.isIntersecting) loadMore();
            }
        }, {
            // Trigger ~1 viewport below so there's time to fetch before the
            // user hits the literal bottom of the grid.
            rootMargin: '400px 0px',
            threshold: 0,
        });
        observer.observe(sentinelRef.current);
        return () => observer.disconnect();
    }, [hasMore, loadMore]);

    if (!query || !query.trim()) {
        return <div className={styles['empty-message']}>Type a query in the search bar above.</div>;
    }

    return (
        <div className={classnames(styles['search-results-root'], 'animation-fade-in')}>
            <div className={styles['search-results-header']}>
                <div className={styles['search-results-title']}>
                    Results for &ldquo;{query}&rdquo;
                </div>
                {stale ? (
                    <div className={styles['search-results-stale']} title="Refreshing in background">
                        refreshing…
                    </div>
                ) : refreshFailed ? (
                    <div className={styles['search-results-stale']} title="Background refresh failed — showing cached results">
                        couldn&rsquo;t refresh
                    </div>
                ) : null}
            </div>

            {loading && results.length === 0 ? (
                <div className={styles['search-results-grid']}>
                    {Array.from({ length: 24 }).map((_, i) => (
                        <div key={i} className={styles['search-results-skeleton']} />
                    ))}
                </div>
            ) : results.length === 0 ? (
                <div className={styles['empty-message']}>No results for &ldquo;{query}&rdquo;.</div>
            ) : (
                <div className={styles['search-results-grid']}>
                    {results.map((item) => (
                        <IncognitoCard
                            key={item.id}
                            {...item}
                            className={styles['search-results-cell']}
                        />
                    ))}
                    {hasMore ? (
                        <div ref={sentinelRef} className={styles['search-results-load-sentinel']}>
                            {loadingMore ? 'Loading more…' : ' '}
                        </div>
                    ) : null}
                </div>
            )}
        </div>
    );
}

module.exports = IncognitoSearchResults;
