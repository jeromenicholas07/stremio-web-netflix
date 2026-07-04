// Copyright (C) 2017-2026 Smart code 203358507

// iOS-only "Add to Home Screen" hint. iOS Safari fires no `beforeinstallprompt`
// event, so a PWA install must be prompted manually. Shown only in iOS Safari
// (not once installed / running standalone), and dismissible for good.

const React = require('react');
const PropTypes = require('prop-types');
const classnames = require('classnames');
const { default: Icon } = require('@stremio/stremio-icons/react');
// Import Button from its module (not the components index) to avoid a circular
// dependency — the index imports this component.
const { default: Button } = require('stremio/components/Button');
// Import usePlatform from its source module (not the 'stremio/common' barrel) —
// this component is loaded eagerly via the components barrel, and going through
// 'stremio/common' creates a circular import where usePlatform is still undefined.
const { usePlatform } = require('stremio/common/Platform');
const usePWA = require('stremio/common/usePWA');
const styles = require('./styles');

const DISMISS_KEY = 'ios_install_banner_dismissed';

function readDismissed() {
    try {
        return window.localStorage.getItem(DISMISS_KEY) === 'true';
    } catch {
        return false;
    }
}

const IosInstallBanner = ({ className }) => {
    const platform = usePlatform();
    const [isIOSPWA] = usePWA();
    const [dismissed, setDismissed] = React.useState(readDismissed);

    const onDismiss = React.useCallback(() => {
        setDismissed(true);
        try {
            window.localStorage.setItem(DISMISS_KEY, 'true');
        } catch {
            // Storage unavailable (private mode) — hide for this session only.
        }
    }, []);

    // iOS Safari only, not when already installed to the Home Screen.
    if (platform.name !== 'ios' || isIOSPWA || dismissed) {
        return null;
    }

    return (
        <div className={classnames(className, styles['ios-install-banner'])}>
            <Icon className={styles['share-icon']} name={'share'} />
            <div className={styles['text']}>
                <div className={styles['title']}>{'Add Stremio to your Home Screen'}</div>
                <div className={styles['subtitle']}>{'Tap the Share button, then “Add to Home Screen” for a full-screen app.'}</div>
            </div>
            <Button
                className={styles['dismiss']}
                title={'Dismiss'}
                onClick={onDismiss}
            >
                <Icon className={styles['dismiss-icon']} name={'close'} />
            </Button>
        </div>
    );
};

IosInstallBanner.propTypes = {
    className: PropTypes.string,
};

module.exports = IosInstallBanner;
