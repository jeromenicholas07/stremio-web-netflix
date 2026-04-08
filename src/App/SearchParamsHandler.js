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
    // streaming server URL points to the CORS proxy (12470), not direct (11470).
    // This handles cases where stremio-core persisted the old 11470 URL.
    React.useEffect(() => {
        if (!profile || !profile.settings) return;
        const currentUrl = profile.settings.streamingServerUrl;
        const correctUrl = CONSTANTS.DEFAULT_STREAMING_SERVER_URL;
        if (currentUrl && correctUrl && currentUrl !== correctUrl
            && currentUrl.indexOf(':11470') !== -1
            && correctUrl.indexOf(':12470') !== -1) {
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
