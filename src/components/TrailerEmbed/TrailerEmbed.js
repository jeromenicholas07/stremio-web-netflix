// Copyright (C) 2017-2024 Smart code 203358507

const React = require('react');
const PropTypes = require('prop-types');
const classnames = require('classnames');
const styles = require('./styles');

const TrailerEmbed = React.memo(({ className, ytId, muted = true }) => {
    if (!ytId) return null;

    return (
        <div className={classnames(className, styles['trailer-embed-container'])}>
            <iframe
                className={styles['trailer-iframe']}
                src={`https://www.youtube.com/embed/${ytId}?autoplay=1&mute=${muted ? 1 : 0}&controls=0&modestbranding=1&rel=0&showinfo=0&loop=1&playlist=${ytId}`}
                allow="autoplay; encrypted-media"
                allowFullScreen
                frameBorder="0"
                loading="lazy"
            />
        </div>
    );
});

TrailerEmbed.displayName = 'TrailerEmbed';

TrailerEmbed.propTypes = {
    className: PropTypes.string,
    ytId: PropTypes.string,
    muted: PropTypes.bool,
};

module.exports = TrailerEmbed;
