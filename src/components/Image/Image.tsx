// Copyright (C) 2017-2023 Smart code 203358507

import React, { useCallback, useLayoutEffect, useState } from 'react';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const upgradeImageUrl = require('stremio/common/upgradeImageUrl');

type Props = {
    className: string,
    src: string,
    alt: string,
    fallbackSrc: string,
    renderFallback: () => React.ReactNode,
    onError: (event: React.SyntheticEvent<HTMLImageElement>) => void,
};

const Image = ({ className, src, alt, fallbackSrc, renderFallback, ...props }: Props) => {
    const [broken, setBroken] = useState(false);
    const onError = useCallback((event: React.SyntheticEvent<HTMLImageElement>) => {
        if (typeof props.onError === 'function') {
            props.onError(event);
        }

        setBroken(true);
    }, [props.onError]);

    useLayoutEffect(() => {
        setBroken(false);
    }, [src]);

    // Auto-upgrade well-known low-res image URLs (Cinemeta / TMDB) so cards
    // and fullscreen backgrounds stay sharp on high-DPI / 4K displays.
    const upgradedSrc = upgradeImageUrl(src);
    const upgradedFallback = upgradeImageUrl(fallbackSrc);

    return (broken || typeof upgradedSrc !== 'string' || upgradedSrc.length === 0) && (typeof renderFallback === 'function' || typeof upgradedFallback === 'string') ?
        typeof renderFallback === 'function' ?
            renderFallback()
            :
            <img {...props} className={className} src={upgradedFallback} alt={alt} loading='lazy'/>
        :
        <img {...props} className={className} src={upgradedSrc} alt={alt} loading='lazy' onError={onError} />;
};

export default Image;
