// Copyright (C) 2017-2023 Smart code 203358507

const React = require('react');
const PropTypes = require('prop-types');
const classnames = require('classnames');
const { default: Icon } = require('@stremio/stremio-icons/react');
const { Button, Image } = require('stremio/components');
const { default: useFullscreen } = require('stremio/common/useFullscreen');
// Direct source import (not the 'stremio/common' barrel) — this file is pulled
// in eagerly via the components barrel, so the barrel can be mid-init here.
const { usePlatform } = require('stremio/common/Platform');
const SearchBar = require('./SearchBar');
const NavMenu = require('./NavMenu');
const styles = require('./styles');

const NAV_LINKS = [
    { id: 'board', label: 'Home', href: '#/' },
    { id: 'mylist', label: 'My List', href: '#/mylist' },
    { id: 'incognito', label: 'Incognito', href: '#/incognito', icon: 'eye-off-outline' },
];

const HorizontalNavBar = React.memo(({ className, route, query, title, backButton, backButtonHref, searchBar, fullscreenButton, navMenu, ...props }) => {
    const platform = usePlatform();
    // Hide the Incognito tab on iOS.
    const navLinks = React.useMemo(() => (
        platform.name === 'ios' ? NAV_LINKS.filter((link) => link.id !== 'incognito') : NAV_LINKS
    ), [platform.name]);
    const [scrolled, setScrolled] = React.useState(false);
    const backButtonOnClick = React.useCallback(() => {
        // When a fixed target is given (e.g. detail pages on mobile go straight
        // to Home), navigate there — history.back() is unreliable after
        // replace()-based auto-pick redirects and can leave the app in a
        // confusing state. Otherwise fall back to normal history navigation.
        if (typeof backButtonHref === 'string' && backButtonHref.length > 0) {
            window.location.hash = backButtonHref;
            return;
        }
        window.history.back();
    }, [backButtonHref]);
    const [fullscreen, requestFullscreen, exitFullscreen] = useFullscreen();
    const renderNavMenuLabel = React.useCallback(({ ref, className, onClick, children }) => (
        <Button ref={ref} className={classnames(className, styles['button-container'], styles['menu-button-container'])} tabIndex={-1} onClick={onClick}>
            <Icon className={styles['icon']} name={'person-outline'} />
            {children}
        </Button>
    ), []);

    React.useEffect(() => {
        const handleScroll = () => {
            const scrollTarget = document.querySelector('[data-scroll-container]');
            if (scrollTarget) {
                setScrolled(scrollTarget.scrollTop > 10);
            }
        };
        const scrollTarget = document.querySelector('[data-scroll-container]');
        if (scrollTarget) {
            scrollTarget.addEventListener('scroll', handleScroll);
            return () => scrollTarget.removeEventListener('scroll', handleScroll);
        }
        window.addEventListener('scroll', handleScroll, true);
        return () => window.removeEventListener('scroll', handleScroll, true);
    }, []);

    return (
        <nav {...props} className={classnames(className, styles['horizontal-nav-bar-container'], { [styles['scrolled']]: scrolled })}>
            {
                backButton ?
                    <Button className={classnames(styles['button-container'], styles['back-button-container'])} tabIndex={-1} onClick={backButtonOnClick}>
                        <Icon className={styles['icon']} name={'chevron-back'} />
                    </Button>
                    :
                    <Button className={styles['logo-container']} href={'#/'} tabIndex={-1}>
                        <Image
                            className={styles['logo']}
                            src={require('/assets/images/stremio_custom_logo.svg')}
                            alt={' '}
                        />
                    </Button>
            }
            {
                !backButton ?
                    <div className={styles['nav-links']}>
                        {navLinks.map((link) => (
                            <Button
                                key={link.id}
                                className={classnames(styles['nav-link'], { [styles['nav-link-active']]: route === link.id })}
                                href={link.href}
                                tabIndex={-1}
                            >
                                {link.icon ? <Icon className={styles['nav-link-icon']} name={link.icon} /> : null}
                                {link.label}
                            </Button>
                        ))}
                    </div>
                    :
                    null
            }
            {
                typeof title === 'string' && title.length > 0 ?
                    <h2 className={styles['title']}>{title}</h2>
                    :
                    null
            }
            <div className={styles['spacer']} />
            {
                searchBar && route !== 'addons' ?
                    <SearchBar
                        className={styles['search-bar']}
                        query={query}
                        active={route === 'search' || route === 'incognito'}
                        context={route === 'incognito' ? 'incognito' : undefined}
                    />
                    :
                    null
            }
            <div className={styles['buttons-container']}>
                {
                    navMenu ?
                        <NavMenu renderLabel={renderNavMenuLabel} />
                        :
                        null
                }
            </div>
        </nav>
    );
});

HorizontalNavBar.displayName = 'HorizontalNavBar';

HorizontalNavBar.propTypes = {
    className: PropTypes.string,
    route: PropTypes.string,
    query: PropTypes.string,
    title: PropTypes.string,
    backButton: PropTypes.bool,
    backButtonHref: PropTypes.string,
    searchBar: PropTypes.bool,
    fullscreenButton: PropTypes.bool,
    navMenu: PropTypes.bool
};

module.exports = HorizontalNavBar;
