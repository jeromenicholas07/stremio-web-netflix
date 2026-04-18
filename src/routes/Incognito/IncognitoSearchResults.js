const React = require('react');
const classnames = require('classnames');
const { MetaItem, MetaRow } = require('stremio/components');
const useIncognitoSearch = require('./useIncognitoSearch');
const styles = require('./styles');

function IncognitoSearchResults({ query }) {
    const { results, loading } = useIncognitoSearch(query);

    if (loading) {
        return <div className={styles['loading-container']}>Searching…</div>;
    }
    if (!query || !query.trim()) {
        return <div className={styles['empty-message']}>Type a query in the search bar above.</div>;
    }
    if (results.length === 0) {
        return <div className={styles['empty-message']}>No results for &ldquo;{query}&rdquo;.</div>;
    }

    return (
        <MetaRow
            className={classnames(styles['catalog-row'], 'animation-fade-in')}
            title={`Results for "${query}"`}
            catalog={{ content: { type: 'Ready', content: results } }}
            itemComponent={MetaItem}
        />
    );
}

module.exports = IncognitoSearchResults;
