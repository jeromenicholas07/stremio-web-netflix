// Copyright (C) 2017-2024 Smart code 203358507
// Global trailer state: active trailer tracking + universal mute + visibility

const React = require('react');

const TrailerContext = React.createContext(null);

function TrailerProvider({ children }) {
    // 'hero' or a card id string, or null
    const [activeTrailerId, setActiveTrailerId] = React.useState(null);
    const [globalMuted, setGlobalMuted] = React.useState(true);
    const [pageVisible, setPageVisible] = React.useState(!document.hidden);
    const [heroInView, setHeroInView] = React.useState(true);
    // Promoted item — card item pushed to hero banner
    const [promotedItem, setPromotedItem] = React.useState(null);

    const setActiveTrailer = React.useCallback((id) => {
        setActiveTrailerId(id);
    }, []);

    const clearActiveTrailer = React.useCallback((id) => {
        setActiveTrailerId((prev) => (prev === id ? null : prev));
    }, []);

    const toggleGlobalMute = React.useCallback(() => {
        setGlobalMuted((prev) => !prev);
    }, []);

    // Promote a MetaItem to the hero banner
    const promoteToHero = React.useCallback((item) => {
        setPromotedItem(item);
        setActiveTrailerId('hero');
    }, []);

    // Listen for tab visibility changes
    React.useEffect(() => {
        const onVisibilityChange = () => {
            setPageVisible(!document.hidden);
        };
        document.addEventListener('visibilitychange', onVisibilityChange);

        // Also handle window blur/focus for alt-tab, minimize etc.
        const onBlur = () => setPageVisible(false);
        const onFocus = () => setPageVisible(true);
        window.addEventListener('blur', onBlur);
        window.addEventListener('focus', onFocus);

        return () => {
            document.removeEventListener('visibilitychange', onVisibilityChange);
            window.removeEventListener('blur', onBlur);
            window.removeEventListener('focus', onFocus);
        };
    }, []);

    const value = React.useMemo(
        () => ({
            activeTrailerId,
            setActiveTrailer,
            clearActiveTrailer,
            globalMuted,
            toggleGlobalMute,
            pageVisible,
            heroInView,
            setHeroInView,
            promotedItem,
            promoteToHero,
        }),
        [activeTrailerId, globalMuted, setActiveTrailer, clearActiveTrailer, toggleGlobalMute, pageVisible, heroInView, promotedItem, promoteToHero],
    );

    return React.createElement(TrailerContext.Provider, { value }, children);
}

module.exports = { TrailerContext, TrailerProvider };
