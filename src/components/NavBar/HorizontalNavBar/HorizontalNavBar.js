// Copyright (C) 2017-2023 Smart code 203358507

const React = require('react');
const PropTypes = require('prop-types');
const classnames = require('classnames');
const { default: Icon } = require('@stremio/stremio-icons/react');
const { Button, Image } = require('stremio/components');
const { default: useFullscreen } = require('stremio/common/useFullscreen');
const SearchBar = require('./SearchBar');
const NavMenu = require('./NavMenu');
const styles = require('./styles');

const NAV_LINKS = [
    { id: 'board', label: 'Home', href: '#/' },
    { id: 'discover', label: 'TV Shows', href: '#/discover' },
    { id: 'library', label: 'Movies', href: '#/library' },
    { id: 'calendar', label: 'My List', href: '#/calendar' },
];

const HorizontalNavBar = React.memo(({ className, route, query, title, backButton, searchBar, fullscreenButton, navMenu, ...props }) => {
    const [scrolled, setScrolled] = React.useState(false);
    const backButtonOnClick = React.useCallback(() => {
        window.history.back();
    }, []);
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
                    <div className={styles['logo-container']}>
                        <Image
                            className={styles['logo']}
                            src={require('/assets/images/stremio_symbol.png')}
                            alt={' '}
                        />
                    </div>
            }
            {
                !backButton ?
                    <div className={styles['nav-links']}>
                        {NAV_LINKS.map((link) => (
                            <Button
                                key={link.id}
                                className={classnames(styles['nav-link'], { [styles['nav-link-active']]: route === link.id })}
                                href={link.href}
                                tabIndex={-1}
                            >
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
                    <SearchBar className={styles['search-bar']} query={query} active={route === 'search'} />
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
    searchBar: PropTypes.bool,
    fullscreenButton: PropTypes.bool,
    navMenu: PropTypes.bool
};

module.exports = HorizontalNavBar;
