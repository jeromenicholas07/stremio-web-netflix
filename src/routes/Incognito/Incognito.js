const React = require('react');
const classnames = require('classnames');
const { default: Icon } = require('@stremio/stremio-icons/react');
const { MainNavBars, MetaRow } = require('stremio/components');
const usePinGate = require('./usePinGate');
const PinDialog = require('./PinDialog');
const IncognitoSettings = require('./IncognitoSettings');
const IncognitoDetails = require('./IncognitoDetails');
const IncognitoSearchResults = require('./IncognitoSearchResults');
const IncognitoCard = require('./IncognitoCard');
const useIncognitoCatalogs = require('./useIncognitoCatalogs');
const useIncognitoCustomRows = require('./useIncognitoCustomRows');
const styles = require('./styles');

const Incognito = ({ urlParams }) => {
    const { state: pinState, createPin, verifyPin, resetPin, lock } = usePinGate();
    const [showSettings, setShowSettings] = React.useState(false);
    const { catalogs, loading: catalogsLoading, addonUrl } = useIncognitoCatalogs();
    const customCatalogs = useIncognitoCustomRows();

    const subpage = urlParams && urlParams.subpage;
    const subpageArg = urlParams && urlParams.subpageArg;

    const handleSettingsClose = React.useCallback((reload) => {
        setShowSettings(false);
        if (reload) window.location.reload();
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

    // No addon configured — setup prompt
    if (!addonUrl) {
        return (
            <div className={styles['incognito-container']}>
                <MainNavBars className={styles['incognito-content-container']} route={'incognito'}>
                    <div className={styles['incognito-content']} data-scroll-container>
                        <div className={styles['setup-container']}>
                            <div className={styles['setup-title']}>Setup Required</div>
                            <div className={styles['setup-description']}>
                                Run the Incognito Catalogs addon server and open settings to verify the connection.
                            </div>
                            <button className={styles['setup-button']} onClick={() => setShowSettings(true)} type="button">
                                Open Settings
                            </button>
                        </div>
                    </div>
                </MainNavBars>
                {showSettings ? (
                    <IncognitoSettings onClose={handleSettingsClose} onResetPin={handleResetPin} />
                ) : null}
            </div>
        );
    }

    const renderIcons = () => (
        <div className={styles['header-right']}>
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
    );

    // Branch on URL subpage
    let body;
    if (subpage === 'details' && subpageArg) {
        body = (
            <React.Fragment>
                <div className={styles['incognito-header']}>
                    <div className={styles['header-left']} />
                    {renderIcons()}
                </div>
                <IncognitoDetails id={decodeURIComponent(subpageArg)} />
            </React.Fragment>
        );
    } else if (subpage === 'search' && subpageArg) {
        body = (
            <React.Fragment>
                <div className={styles['incognito-header']}>
                    <div className={styles['header-left']} />
                    {renderIcons()}
                </div>
                <div className={styles['search-container']}>
                    <IncognitoSearchResults query={decodeURIComponent(subpageArg)} />
                </div>
            </React.Fragment>
        );
    } else {
        body = (
            <React.Fragment>
                <div className={styles['incognito-header']}>
                    <div className={styles['header-left']} />
                    {renderIcons()}
                </div>
                <div className={styles['catalog-rows']}>
                    {catalogsLoading ? (
                        <div className={styles['loading-container']}>Loading catalogs…</div>
                    ) : catalogs.length === 0 && customCatalogs.length === 0 ? (
                        <div className={styles['empty-message']}>
                            No catalogs available. Check your addon connection in settings.
                        </div>
                    ) : (
                        <React.Fragment>
                            {catalogs.map((catalog) => (
                                <MetaRow
                                    key={catalog.id}
                                    className={classnames(styles['catalog-row'], 'animation-fade-in')}
                                    title={catalog.name}
                                    catalog={catalog}
                                    itemComponent={IncognitoCard}
                                />
                            ))}
                            {customCatalogs.map((catalog) => {
                                // Hide rows that haven't fetched yet (cold first
                                // visit). Cached rows show instantly; errored
                                // rows render empty rather than vanishing, so
                                // the user still sees the title they added.
                                if (catalog._customStatus === 'loading') return null;
                                return (
                                    <MetaRow
                                        key={catalog.id}
                                        className={classnames(styles['catalog-row'], 'animation-fade-in')}
                                        title={catalog.name}
                                        catalog={catalog}
                                        itemComponent={IncognitoCard}
                                    />
                                );
                            })}
                        </React.Fragment>
                    )}
                </div>
            </React.Fragment>
        );
    }

    return (
        <div className={styles['incognito-container']}>
            <MainNavBars className={styles['incognito-content-container']} route={'incognito'}>
                <div className={styles['incognito-content']} data-scroll-container>
                    {body}
                </div>
            </MainNavBars>
            {showSettings ? (
                <IncognitoSettings onClose={handleSettingsClose} onResetPin={handleResetPin} />
            ) : null}
        </div>
    );
};

module.exports = Incognito;
