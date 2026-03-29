// Copyright (C) 2017-2023 Smart code 203358507

const React = require('react');
const PropTypes = require('prop-types');
const { useServices } = require('stremio/services');
const LibItem = require('stremio/components/LibItem');
const traktBridge = require('stremio/services/TraktBridge');

const ContinueWatchingItem = ({ _id, notifications, type, name, ...props }) => {
    const { core } = useServices();

    const onDismissClick = React.useCallback((event) => {
        event.preventDefault();
        if (typeof _id === 'string') {
            core.transport.dispatch({
                action: 'Ctx',
                args: {
                    action: 'RewindLibraryItem',
                    args: _id
                }
            });
            core.transport.dispatch({
                action: 'Ctx',
                args: {
                    action: 'DismissNotificationItem',
                    args: _id
                }
            });
        }
    }, [_id]);

    // Called by MetaItem when +, -, "already watched", or rating actions happen on a CW item.
    // Removes the item from continue watching in both Stremio core and Trakt.
    const onCWAction = React.useCallback((actionType) => {
        if (typeof _id !== 'string') return;

        // Rewind (reset progress) so item leaves continue watching
        core.transport.dispatch({
            action: 'Ctx',
            args: {
                action: 'RewindLibraryItem',
                args: _id
            }
        });
        core.transport.dispatch({
            action: 'Ctx',
            args: {
                action: 'DismissNotificationItem',
                args: _id
            }
        });

        // Sync to Trakt: mark as watched so it leaves "currently watching"
        if (traktBridge.isConfigured()) {
            const itemType = (type === 'series' || type === 'tv') ? 'series' : 'movie';
            traktBridge.markWatched(_id, itemType).catch((err) => {
                console.warn('Trakt CW markWatched failed:', err.message);
            });
        }

        window.dispatchEvent(new Event('stremio-dismissed-updated'));
    }, [_id, type, core]);

    return (
        <LibItem
            {...props}
            _id={_id}
            type={type}
            name={name}
            posterChangeCursor={true}
            notifications={notifications}
            onDismissClick={onDismissClick}
            onCWAction={onCWAction}
        />
    );
};

ContinueWatchingItem.propTypes = {
    _id: PropTypes.string,
    type: PropTypes.string,
    name: PropTypes.string,
    notifications: PropTypes.object,
    deepLinks: PropTypes.shape({
        metaDetailsVideos: PropTypes.string,
        metaDetailsStreams: PropTypes.string,
        player: PropTypes.string
    }),
};

module.exports = ContinueWatchingItem;
