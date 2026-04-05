const React = require('react');
const classnames = require('classnames');
const { withCoreSuspender } = require('stremio/common');
const { MainNavBars, MetaItem, MetaRow, ContinueWatchingItem } = require('stremio/components');
const useTraktLists = require('../Board/useTraktLists');
const useWatchedNotRated = require('../Board/useWatchedNotRated');
const useContinueWatchingPreview = require('../Board/useContinueWatchingPreview');
const traktBridge = require('stremio/services/TraktBridge');
const styles = require('./styles');

const RateMetaItem = React.memo((props) => {
    return React.createElement(MetaItem, { ...props, rateMode: true });
});
RateMetaItem.displayName = 'RateMetaItem';

const MyList = () => {
    const { watchlistItems, notInterestedItems } = useTraktLists();
    const watchedNotRatedItems = useWatchedNotRated();
    const continueWatchingPreview = useContinueWatchingPreview();
    const isConnected = traktBridge.isConnected();

    return (
        <MainNavBars className={styles['mylist-container']} route={'mylist'}>
            <div className={styles['mylist-content']} data-scroll-container>
                <h1 className={styles['page-title']}>My List</h1>

                {!isConnected && (
                    <div className={styles['connect-message']}>
                        <p>Connect your Trakt account in Settings to see your personal lists here.</p>
                    </div>
                )}

                {continueWatchingPreview.items.length > 0 && (
                    <MetaRow
                        className={classnames(styles['list-row'], 'animation-fade-in')}
                        title={'Continue Watching'}
                        catalog={continueWatchingPreview}
                        itemComponent={ContinueWatchingItem}
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

                {isConnected && watchlistItems.length === 0 && watchedNotRatedItems.length === 0 && notInterestedItems.length === 0 && continueWatchingPreview.items.length === 0 && (
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
