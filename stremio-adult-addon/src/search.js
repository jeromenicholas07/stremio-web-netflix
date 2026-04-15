const { handleCatalog } = require('./catalog');

/**
 * Handle a search request. Delegates to catalog with search extra.
 */
async function handleSearch(query, extra = {}) {
    return handleCatalog('adult-search', { ...extra, search: query });
}

module.exports = { handleSearch };
