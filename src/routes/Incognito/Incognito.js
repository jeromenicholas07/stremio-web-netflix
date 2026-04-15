const React = require('react');
const classnames = require('classnames');
const { default: Icon } = require('@stremio/stremio-icons/react');
const { MainNavBars, MetaItem, MetaRow } = require('stremio/components');
const usePinGate = require('./usePinGate');
const PinDialog = require('./PinDialog');
const IncognitoSearchBar = require('./IncognitoSearchBar');
const IncognitoSettings = require('./IncognitoSettings');
const useIncognitoCatalogs = require('./useIncognitoCatalogs');
const useIncognitoSearch = require('./useIncognitoSearch');
const styles = require('./styles');

const Incognito = () => {
    const { state: pinState, createPin, verifyPin, resetPin, lock } = usePinGate();
    const [tab, setTab] = React.useState('browse');
    const [showSettings, setShowSettings] = React.useState(false);
    const { catalogs, loading: catalogsLoading, addonUrl, fetchCatalogWithGenre, loadNextPage } = useIncognitoCatalogs();
    const { results: searchResults, loading: searchLoading, search } = useIncognitoSearch();

    const handleSettingsClose = React.useCallback((reload) => {
        setShowSettings(false);
        if (reload) {
            // Force re-mount by toggling a key — simplest way to refresh catalogs
            window.location.reload();
        }
    }, []);

    const handleResetPin = React.useCallback(() => {
        resetPin();
        setShowSettings(false);
    }, [resetPin]);

    // PIN gate
    if (pinState === 'no_pin') {
        return <PinDialog mode="create" onCreatePin={createPin} />;
    }
    if (pinState === 'locked') {
        return <PinDialog mode="verify" onVerifyPin={verifyPin} />;
    }

    // No addon configured — show setup prompt
    if (!addonUrl) {
        return (
            <div className={styles['incognito-container']}>
                <MainNavBars className={styles['incognito-content-container']} route={'incognito'}>
                    <div className={styles['incognito-content']} data-scroll-container>
                        <div className={styles['setup-container']}>
                            <div className={styles['setup-title']}>Setup Required</div>
                            <div className={styles['setup-description']}>
                                You need to configure an addon URL to browse content.
                                Run the Incognito Catalogs addon server and enter its URL in settings.
                            </div>
                            <button
                                className={styles['setup-button']}
                                onClick={() => setShowSettings(true)}
                                type="button"
                            >
                                Open Settings
                            </button>
                        </div>
                    </div>
                </MainNavBars>
                {showSettings ? (
                    <IncognitoSettings
                        onClose={handleSettingsClose}
                        onResetPin={handleResetPin}
                    />
                ) : null}
            </div>
        );
    }

    return (
        <div className={styles['incognito-container']}>
            <MainNavBars className={styles['incognito-content-container']} route={'incognito'}>
                <div className={styles['incognito-content']} data-scroll-container>
                    <div className={styles['incognito-header']}>
                        <div className={styles['header-left']}>
                            <button
                                className={classnames(styles['tab-button'], { [styles['active']]: tab === 'browse' })}
                                onClick={() => setTab('browse')}
                                type="button"
                            >
                                Browse
                            </button>
                            <button
                                className={classnames(styles['tab-button'], { [styles['active']]: tab === 'search' })}
                                onClick={() => setTab('search')}
                                type="button"
                            >
                                Search
                            </button>
                        </div>
                        <div className={styles['header-right']}>
                            {tab === 'search' ? (
                                <IncognitoSearchBar onSearch={search} />
                            ) : null}
                            <button
                                className={styles['settings-icon-button']}
                                onClick={() => setShowSettings(true)}
                                title="Settings"
                                type="button"
                            >
                                <Icon name={'settings'} />
                            </button>
                            <button
                                className={styles['lock-icon-button']}
                                onClick={lock}
                                title="Lock"
                                type="button"
                            >
                                <Icon name={'lock-outline'} />
                            </button>
                        </div>
                    </div>

                    {tab === 'browse' ? (
                        <div className={styles['catalog-rows']}>
                            {catalogsLoading ? (
                                <div className={styles['loading-container']}>Loading catalogs...</div>
                            ) : catalogs.length === 0 ? (
                                <div className={styles['empty-message']}>
                                    No catalogs available. Check your addon connection in settings.
                                </div>
                            ) : (
                                catalogs.map((catalog) => (
                                    <MetaRow
                                        key={catalog.id}
                                        className={classnames(styles['catalog-row'], 'animation-fade-in')}
                                        title={catalog.name}
                                        catalog={catalog}
                                        itemComponent={MetaItem}
                                    />
                                ))
                            )}
                        </div>
                    ) : (
                        <div className={styles['search-container']}>
                            {searchLoading ? (
                                <div className={styles['loading-container']}>Searching...</div>
                            ) : searchResults.length > 0 ? (
                                <MetaRow
                                    className={classnames(styles['catalog-row'], 'animation-fade-in')}
                                    title={'Search Results'}
                                    catalog={{ content: { type: 'Ready', content: searchResults } }}
                                    itemComponent={MetaItem}
                                />
                            ) : (
                                <div className={styles['empty-message']}>
                                    {search.query ? 'No results found.' : 'Type to search...'}
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </MainNavBars>
            {showSettings ? (
                <IncognitoSettings
                    onClose={handleSettingsClose}
                    onResetPin={handleResetPin}
                />
            ) : null}
        </div>
    );
};

module.exports = Incognito;
