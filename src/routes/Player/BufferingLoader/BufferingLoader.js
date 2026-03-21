// Copyright (C) 2017-2023 Smart code 203358507

const React = require('react');
const PropTypes = require('prop-types');
const classnames = require('classnames');
const styles = require('./styles');

const BufferingLoader = React.forwardRef(({ className }, ref) => {
    return (
        <div ref={ref} className={classnames(className, styles['buffering-loader-container'])}>
            <div className={styles['buffering-loader']} />
        </div>
    );
});

BufferingLoader.propTypes = {
    className: PropTypes.string,
};

module.exports = BufferingLoader;
