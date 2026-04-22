// Full-viewport grid of IncognitoCards. The previous single-`MetaRow`
// layout only showed one horizontally-scrolling row for search results,
// which wasted the bulk of the screen. CSS-grid auto-fill + minmax gives
// a Discover-style reflowing multi-row grid without any JS measurement.
//
// Data flow is unchanged: `useIncognitoSearch` owns the fetch + cache,
// we just render its `results` array as a grid of cards and surface
// `stale` as a subtle badge.

const React = require('react');
const classnames = require('classnames');
const useIncognitoSearch = require('./useIncognitoSearch');
const IncognitoCard = require('./IncognitoCard');
const styles = require('./styles');

function IncognitoSearchResults({ query }) {
    const { results, loading, stale } = useIncognitoSearch(query);

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
                ) : null}
            </div>

            {loading && results.length === 0 ? (
                <div className={styles['search-results-grid']}>
                    {Array.from({ length: 18 }).map((_, i) => (
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
                </div>
            )}
        </div>
    );
}

module.exports = IncognitoSearchResults;
