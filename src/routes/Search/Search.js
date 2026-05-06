// Copyright (C) 2017-2023 Smart code 203358507

const React = require('react');
const PropTypes = require('prop-types');
const classnames = require('classnames');
const debounce = require('lodash.debounce');
const useTranslate = require('stremio/common/useTranslate');
const { default: Icon } = require('@stremio/stremio-icons/react');
const { withCoreSuspender, getVisibleChildrenRange } = require('stremio/common');
const { Image, MainNavBars, MetaItem, MetaRow } = require('stremio/components');
const useSearch = require('./useSearch');
const useProwlarrSearch = require('./useProwlarrSearch');
const styles = require('./styles');

const THRESHOLD = 100;

const Search = ({ queryParams }) => {
    const t = useTranslate();
    const [search, loadSearchRows] = useSearch(queryParams);
    const searchQuery = React.useMemo(() => {
        return queryParams?.get('search') ?? queryParams?.get('query') ?? null;
    }, [queryParams]);
    const prowlarr = useProwlarrSearch(searchQuery);
    const query = React.useMemo(() => {
        return search.selected !== null ?
            search.selected.extra.reduceRight((query, [name, value]) => {
                if (name === 'search') {
                    return value;
                }

                return query;
            }, null)
            :
            null;
    }, [search.selected]);
    const scrollContainerRef = React.useRef();
    const onVisibleRangeChange = React.useCallback(() => {
        if (search.catalogs.length === 0) {
            return;
        }

        const range = getVisibleChildrenRange(scrollContainerRef.current, THRESHOLD);
        if (range === null) {
            return;
        }

        loadSearchRows(range);
    }, [search.catalogs]);
    const onScroll = React.useCallback(debounce(onVisibleRangeChange, 250), [onVisibleRangeChange]);
    React.useLayoutEffect(() => {
        onVisibleRangeChange();
    }, [search.catalogs, onVisibleRangeChange]);
    return (
        <MainNavBars className={styles['search-container']} route={'search'} query={query}>
            <div ref={scrollContainerRef} className={styles['search-content']} onScroll={onScroll}>
                {
                    query === null ?
                        <div className={classnames(styles['search-hints-wrapper'])}>
                            <div className={classnames(styles['search-hints-title-container'], 'animation-fade-in')}>
                                <div className={styles['search-hints-title']}>{t.string('SEARCH_ANYTHING')}</div>
                            </div>
                            <div className={classnames(styles['search-hints-container'], 'animation-fade-in')}>
                                <div className={styles['search-hint-container']}>
                                    <Icon className={styles['icon']} name={'trailer'} />
                                    <div className={styles['label']}>{t.string('SEARCH_CATEGORIES')}</div>
                                </div>
                                <div className={styles['search-hint-container']}>
                                    <Icon className={styles['icon']} name={'actors'} />
                                    <div className={styles['label']}>{t.string('SEARCH_PERSONS')}</div>
                                </div>
                                <div className={styles['search-hint-container']}>
                                    <Icon className={styles['icon']} name={'link'} />
                                    <div className={styles['label']}>{t.string('SEARCH_PROTOCOLS')}</div>
                                </div>
                                <div className={styles['search-hint-container']}>
                                    <Icon className={styles['icon']} name={'imdb-outline'} />
                                    <div className={styles['label']}>{t.string('SEARCH_TYPES')}</div>
                                </div>
                            </div>
                        </div>
                        :
                        <React.Fragment>
                            {(() => {
                                // Render order: addon catalog rows first, with Prowlarr's
                                // torrent row inserted at position 3 (so Cinemeta movies +
                                // series come first, then torrents). Torrent results are
                                // sorted by seeders inside the addon and capped at 150 —
                                // see useProwlarrSearch.
                                const PROWLARR_ROW_INDEX = 2; // 0-based: rows 0,1 above; this is the 3rd
                                const renderProwlarrRow = () => prowlarr.metas.length > 0 ? (
                                    <MetaRow
                                        key="prowlarr-torrents"
                                        className={classnames(styles['search-row'], styles['search-row-poster'], 'animation-fade-in')}
                                        catalog={{
                                            id: 'prowlarr-torrents',
                                            name: 'Torrents (sorted by seeders)',
                                            content: { type: 'Ready', content: prowlarr.metas },
                                        }}
                                        title="Torrents (sorted by seeders)"
                                        itemComponent={MetaItem}
                                    />
                                ) : null;

                                const rendered = [];
                                let prowlarrPlaced = false;
                                search.catalogs.forEach((catalog, index) => {
                                    if (!prowlarrPlaced && index === PROWLARR_ROW_INDEX) {
                                        const r = renderProwlarrRow();
                                        if (r) rendered.push(r);
                                        prowlarrPlaced = true;
                                    }
                                    switch (catalog.content?.type) {
                                        case 'Ready': {
                                            rendered.push(
                                                <MetaRow
                                                    key={index}
                                                    className={classnames(styles['search-row'], styles[`search-row-${catalog.content.content[0].posterShape}`], 'animation-fade-in')}
                                                    catalog={catalog}
                                                    itemComponent={MetaItem}
                                                />
                                            );
                                            break;
                                        }
                                        case 'Err': {
                                            if (catalog.content.content !== 'EmptyContent') {
                                                rendered.push(
                                                    <MetaRow
                                                        key={index}
                                                        className={classnames(styles['search-row'], 'animation-fade-in')}
                                                        catalog={catalog}
                                                        message={catalog.content.content}
                                                    />
                                                );
                                            }
                                            break;
                                        }
                                        default: {
                                            rendered.push(
                                                <MetaRow.Placeholder
                                                    key={index}
                                                    className={classnames(styles['search-row'], styles['search-row-poster'], 'animation-fade-in')}
                                                    catalog={catalog}
                                                    title={t.catalogTitle(catalog)}
                                                />
                                            );
                                            break;
                                        }
                                    }
                                });

                                // If there were fewer than PROWLARR_ROW_INDEX catalog rows
                                // before us, we still want to show the torrents row — append
                                // it last instead of dropping it on the floor.
                                if (!prowlarrPlaced) {
                                    const r = renderProwlarrRow();
                                    if (r) rendered.push(r);
                                }
                                return rendered;
                            })()}
                            {search.catalogs.length === 0 && prowlarr.metas.length === 0 && !prowlarr.loading ? (
                                <div className={styles['message-container']}>
                                    <Image
                                        className={styles['image']}
                                        src={require('/assets/images/empty.png')}
                                        alt={' '}
                                    />
                                    <div className={styles['message-label']}>{ t.string('STREMIO_TV_SEARCH_NO_ADDONS') }</div>
                                </div>
                            ) : null}
                        </React.Fragment>
                }
            </div>
        </MainNavBars>
    );
};

Search.propTypes = {
    queryParams: PropTypes.instanceOf(URLSearchParams)
};

const SearchFallback = ({ queryParams }) => (
    <MainNavBars className={styles['search-container']} route={'search'} query={queryParams.get('search') ?? queryParams.get('query')} />
);

SearchFallback.propTypes = Search.propTypes;

module.exports = withCoreSuspender(Search, SearchFallback);
