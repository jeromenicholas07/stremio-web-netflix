// Copyright (C) 2017-2023 Smart code 203358507

const React = require('react');
const ReactIs = require('react-is');
const PropTypes = require('prop-types');
const classnames = require('classnames');
const { default: Icon } = require('@stremio/stremio-icons/react');
const { Button } = require('stremio/components');
const useTranslate = require('stremio/common/useTranslate');
const MetaRowPlaceholder = require('./MetaRowPlaceholder');
const styles = require('./styles');

const MetaRow = ({ className, title, catalog, message, itemComponent, notifications, source, rowContext }) => {
    const t = useTranslate();
    const scrollRef = React.useRef(null);
    const [translateX, setTranslateX] = React.useState(0);
    const [maxTranslate, setMaxTranslate] = React.useState(0);
    const [isRowHovered, setIsRowHovered] = React.useState(false);

    const catalogTitle = React.useMemo(() => {
        return title ?? t.catalogTitle(catalog);
    }, [title, catalog, t.catalogTitle]);

    const items = React.useMemo(() => {
        return catalog?.items ?? catalog?.content?.content;
    }, [catalog]);

    const href = React.useMemo(() => {
        return catalog?.deepLinks?.discover ?? catalog?.deepLinks?.library;
    }, [catalog]);

    const updateMaxTranslate = React.useCallback(() => {
        const el = scrollRef.current;
        if (!el) return;
        const max = Math.max(0, el.scrollWidth - el.clientWidth);
        setMaxTranslate(max);
        // Clamp current translate if items changed
        setTranslateX(prev => Math.min(prev, max));
    }, []);

    const scrollLeft = React.useCallback(() => {
        const el = scrollRef.current;
        if (!el) return;
        const step = el.clientWidth * 0.8;
        setTranslateX(prev => Math.max(0, prev - step));
    }, []);

    const scrollRight = React.useCallback(() => {
        const el = scrollRef.current;
        if (!el) return;
        const step = el.clientWidth * 0.8;
        setTranslateX(prev => Math.min(maxTranslate, prev + step));
    }, [maxTranslate]);

    React.useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        updateMaxTranslate();
        const resizeObserver = new ResizeObserver(updateMaxTranslate);
        resizeObserver.observe(el);
        return () => resizeObserver.disconnect();
    }, [items]);

    const showLeftArrow = translateX > 0;
    const showRightArrow = translateX < maxTranslate - 10;

    return (
        <div
            className={classnames(className, styles['meta-row-container'])}
            onMouseEnter={() => setIsRowHovered(true)}
            onMouseLeave={() => setIsRowHovered(false)}
        >
            <div className={styles['header-container']}>
                {
                    typeof catalogTitle === 'string' && catalogTitle.length > 0 ?
                        <div className={styles['title-container']} title={catalogTitle}>{catalogTitle}</div>
                        :
                        null
                }
                {
                    href && isRowHovered ?
                        <Button className={styles['see-all-container']} title={t.string('BUTTON_SEE_ALL')} href={href} tabIndex={-1}>
                            <div className={styles['label']}>{ t.string('BUTTON_SEE_ALL') }</div>
                            <Icon className={styles['icon']} name={'chevron-forward'} />
                        </Button>
                        :
                        null
                }
                {
                    typeof source === 'string' && source.length > 0 ?
                        <span className={styles['source-label']}>{source}</span>
                        :
                        null
                }
            </div>
            {
                typeof message === 'string' && message.length > 0 ?
                    <div className={styles['message-container']} title={message}>{message}</div>
                    :
                    <div className={styles['carousel-wrapper']}>
                        <button
                            className={classnames(styles['carousel-arrow'], styles['carousel-arrow-left'], { [styles['carousel-arrow-visible']]: showLeftArrow && isRowHovered })}
                            onClick={scrollLeft}
                            tabIndex={-1}
                        >
                            <Icon className={styles['arrow-icon']} name={'chevron-back'} />
                        </button>
                        <div
                            ref={scrollRef}
                            className={styles['meta-items-container']}
                            style={{ transform: `translateX(-${translateX}px)`, transition: 'transform 0.6s cubic-bezier(0.4, 0, 0.2, 1)' }}
                        >
                            {
                                ReactIs.isValidElementType(itemComponent) && Array.isArray(items) ?
                                    items.map((item, index) => {
                                        return React.createElement(itemComponent, {
                                            ...item,
                                            key: item.id || index,
                                            className: classnames(styles['meta-item'], styles['poster-shape-poster'], styles[`poster-shape-${item.posterShape}`]),
                                            notifications,
                                            ...(rowContext ? { rowContext } : {}),
                                        });
                                    })
                                    :
                                    null
                            }
                        </div>
                        <button
                            className={classnames(styles['carousel-arrow'], styles['carousel-arrow-right'], { [styles['carousel-arrow-visible']]: showRightArrow && isRowHovered })}
                            onClick={scrollRight}
                            tabIndex={-1}
                        >
                            <Icon className={styles['arrow-icon']} name={'chevron-forward'} />
                        </button>
                    </div>
            }
        </div>
    );
};

MetaRow.Placeholder = MetaRowPlaceholder;

MetaRow.propTypes = {
    className: PropTypes.string,
    title: PropTypes.string,
    message: PropTypes.string,
    source: PropTypes.string,
    catalog: PropTypes.shape({
        id: PropTypes.string,
        name: PropTypes.string,
        type: PropTypes.string,
        addon: PropTypes.shape({
            manifest: PropTypes.shape({
                id: PropTypes.string,
                name: PropTypes.string,
            }),
        }),
        content: PropTypes.shape({
            content: PropTypes.oneOfType([
                PropTypes.string,
                PropTypes.arrayOf(PropTypes.shape({
                    posterShape: PropTypes.string,
                })),
            ]),
        }),
        items: PropTypes.arrayOf(PropTypes.shape({
            posterShape: PropTypes.string,
        })),
        deepLinks: PropTypes.shape({
            discover: PropTypes.string,
            library: PropTypes.string,
        }),
    }),
    itemComponent: PropTypes.elementType,
    notifications: PropTypes.object,
    rowContext: PropTypes.oneOf(['watchlist', 'not-interested', 'discovery', 'continue-watching']),
};

module.exports = MetaRow;
