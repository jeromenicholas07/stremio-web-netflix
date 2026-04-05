const React = require('react');
const classnames = require('classnames');
const { withCoreSuspender, useNotifications } = require('stremio/common');
const { MainNavBars, MetaItem, MetaRow, ContinueWatchingItem, LibItem } = require('stremio/components');
const useTraktLists = require('../Board/useTraktLists');
const useWatchedNotRated = require('../Board/useWatchedNotRated');
const useContinueWatchingPreview = require('../Board/useContinueWatchingPreview');
const useRecommendations = require('../Board/useRecommendations');
const useLibraryPreview = require('./useLibraryPreview');
const traktBridge = require('stremio/services/TraktBridge');
const styles = require('./styles');

const RateMetaItem = React.memo((props) => {
    return React.createElement(MetaItem, { ...props, rateMode: true });
});
RateMetaItem.displayName = 'RateMetaItem';

// LibItem wrapper that passes removable=true for library items
const LibraryItemComponent = React.memo((props) => {
    return React.createElement(LibItem, { ...props, removable: true });
});
LibraryItemComponent.displayName = 'LibraryItemComponent';

const MyList = () => {
    const { watchlistItems, notInterestedItems } = useTraktLists();
    const watchedNotRatedItems = useWatchedNotRated();
    const continueWatchingPreview = useContinueWatchingPreview();
    const { recommendations } = useRecommendations();
    const library = useLibraryPreview();
    const notifications = useNotifications();
    const isConnected = traktBridge.isConnected();

    const cwItems = continueWatchingPreview && Array.isArray(continueWatchingPreview.items)
        ? continueWatchingPreview.items : [];

    const libraryItems = library && Array.isArray(library.catalog)
        ? library.catalog : [];

    // Filter library items to exclude items already in continue watching
    const cwIds = React.useMemo(() => new Set(cwItems.map((i) => i._id || i.id)), [cwItems]);
    const filteredLibraryItems = React.useMemo(() => {
        return libraryItems.filter((item) => !cwIds.has(item._id || item.id));
    }, [libraryItems, cwIds]);

    const hasAnyContent = cwItems.length > 0
        || filteredLibraryItems.length > 0
        || watchlistItems.length > 0
        || recommendations.length > 0
        || watchedNotRatedItems.length > 0
        || notInterestedItems.length > 0;

    return (
        <MainNavBars className={styles['mylist-container']} route={'mylist'}>
            <div className={styles['mylist-content']} data-scroll-container>
                <h1 className={styles['page-title']}>My List</h1>

                {!isConnected && !hasAnyContent && (
                    <div className={styles['connect-message']}>
                        <p>Connect your Trakt account in Settings to see your personal lists here.</p>
                    </div>
                )}

                {cwItems.length > 0 && (
                    <MetaRow
                        className={classnames(styles['list-row'], 'animation-fade-in')}
                        title={'Continue Watching'}
                        catalog={continueWatchingPreview}
                        itemComponent={ContinueWatchingItem}
                        notifications={notifications}
                    />
                )}

                {filteredLibraryItems.length > 0 && (
                    <MetaRow
                        className={classnames(styles['list-row'], 'animation-fade-in')}
                        title={'Library'}
                        catalog={{ content: { type: 'Ready', content: filteredLibraryItems } }}
                        itemComponent={LibraryItemComponent}
                        notifications={notifications}
                    />
                )}

                {watchlistItems.length > 0 && (
                    <MetaRow
                        className={classnames(styles['list-row'], 'animation-fade-in')}
                        title={'Watchlist'}
                        catalog={{ content: { type: 'Ready', content: watchlistItems } }}
                        itemComponent={MetaItem}
                        source={'Trakt'}
                    />
                )}

                {recommendations.map((rec) => (
                    <MetaRow
                        key={rec.title}
                        className={classnames(styles['list-row'], 'animation-fade-in')}
                        title={rec.title}
                        catalog={{ content: { type: 'Ready', content: rec.items } }}
                        itemComponent={MetaItem}
                        source={'TMDB'}
                    />
                ))}

                {watchedNotRatedItems.length > 0 && (
                    <MetaRow
                        className={classnames(styles['list-row'], 'animation-fade-in')}
                        title={'Watched (Not Rated)'}
                        catalog={{ content: { type: 'Ready', content: watchedNotRatedItems } }}
                        itemComponent={RateMetaItem}
                        source={'Trakt'}
                    />
                )}

                {notInterestedItems.length > 0 && (
                    <MetaRow
                        className={classnames(styles['list-row'], 'animation-fade-in')}
                        title={'Not Interested'}
                        catalog={{ content: { type: 'Ready', content: notInterestedItems } }}
                        itemComponent={MetaItem}
                        source={'Trakt'}
                    />
                )}

                {isConnected && !hasAnyContent && (
                    <div className={styles['empty-message']}>
                        <p>Your lists are empty. Start watching content and it will appear here.</p>
                    </div>
                )}
            </div>
        </MainNavBars>
    );
};

const MyListFallback = () => (
    <MainNavBars className={styles['mylist-container']} route={'mylist'} />
);

module.exports = withCoreSuspender(MyList, MyListFallback);
