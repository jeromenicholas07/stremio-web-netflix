// Copyright (C) 2017-2023 Smart code 203358507

const React = require('react');
const { deepEqual } = require('fast-equals');
const { withCoreSuspender, useProfile, useToast, CONSTANTS } = require('stremio/common');
const { useServices } = require('stremio/services');

const SearchParamsHandler = () => {
    const { core } = useServices();
    const profile = useProfile();
    const toast = useToast();

    const [searchParams, setSearchParams] = React.useState({});

    const onLocationChange = () => {
        const { origin, hash, search } = window.location;
        const { searchParams } = new URL(`${origin}${hash.replace('#', '')}${search}`);

        setSearchParams((previousSearchParams) => {
            const currentSearchParams = Object.fromEntries(searchParams.entries());
            return deepEqual(previousSearchParams, currentSearchParams) ? previousSearchParams : currentSearchParams;
        });
    };

    React.useEffect(() => {
        const { streamingServerUrl } = searchParams;

        if (streamingServerUrl) {
            core.transport.dispatch({
                action: 'Ctx',
                args: {
                    action: 'UpdateSettings',
                    args: {
                        ...profile.settings,
                        streamingServerUrl,
                    },
                },
            });
            core.transport.dispatch({
                action: 'Ctx',
                args: {
                    action: 'AddServerUrl',
                    args: streamingServerUrl,
                },
            });
            toast.show({
                type: 'success',
                title: `Using streaming server at ${streamingServerUrl}`,
                timeout: 4000,
            });
        }
    }, [searchParams]);

    // Auto-fix: when running from a remote origin (GitHub Pages), ensure the
    // streaming server URL points to the CORS proxy at http://127.0.0.1:12470/.
    // Fixes: stale 11470 URLs, LAN IPs (192.168.x.x) that cause Mixed Content blocks.
    React.useEffect(() => {
        if (!profile || !profile.settings) return;
        const currentUrl = profile.settings.streamingServerUrl;
        const correctUrl = CONSTANTS.DEFAULT_STREAMING_SERVER_URL;
        // Fix if: wrong port (11470), wrong host (LAN IP), or any mismatch on remote origins
        const needsFix = currentUrl && correctUrl && currentUrl !== correctUrl
            && (currentUrl.indexOf(':11470') !== -1
                || (currentUrl.indexOf('127.0.0.1') === -1 && currentUrl.indexOf('localhost') === -1));
        if (needsFix) {
            // eslint-disable-next-line no-console
            console.log('[SearchParamsHandler] Auto-fixing streaming server URL:', currentUrl, '->', correctUrl);
            core.transport.dispatch({
                action: 'Ctx',
                args: {
                    action: 'UpdateSettings',
                    args: {
                        ...profile.settings,
                        streamingServerUrl: correctUrl,
                    },
                },
            });
            core.transport.dispatch({
                action: 'Ctx',
                args: {
                    action: 'AddServerUrl',
                    args: correctUrl,
                },
            });
        }
    }, [profile && profile.settings && profile.settings.streamingServerUrl]);

    React.useEffect(() => {
        onLocationChange();
        window.addEventListener('hashchange', onLocationChange);
        return () => window.removeEventListener('hashchange', onLocationChange);
    }, []);

    return null;
};

module.exports = withCoreSuspender(SearchParamsHandler);
