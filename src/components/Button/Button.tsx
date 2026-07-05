// Copyright (C) 2017-2023 Smart code 203358507

import { createElement, forwardRef, useCallback, useRef } from 'react';
import classNames from 'classnames';
import { LongPressEventType, useLongPress } from 'use-long-press';
import { isMobile } from 'stremio/common/Platform/device';
import styles from './Button.less';

// Distance (px) a touch may drift before it's treated as a scroll, not a tap.
const TOUCH_SLOP = 10;

type Props = {
    className?: string,
    style?: object,
    href?: string,
    target?: string
    title?: string,
    disabled?: boolean,
    tabIndex?: number,
    children: React.ReactNode,
    onKeyDown?: (event: React.KeyboardEvent) => void,
    onMouseDown?: (event: React.MouseEvent) => void,
    onMouseUp?: (event: React.MouseEvent) => void,
    onMouseLeave?: (event: React.MouseEvent) => void,
    onLongPress?: () => void,
    onClick?: (event: React.MouseEvent<HTMLDivElement>) => void,
    onDoubleClick?: () => void,
};

const Button = forwardRef(({ className, href, disabled, children, onLongPress, onDoubleClick, ...props }: Props, ref) => {
    const longPress = useLongPress(onLongPress!, { detect: LongPressEventType.Pointer });

    // Touch scroll-vs-tap disambiguation (mobile only). A flick that starts on a
    // card should scroll the page, not navigate. We record the touch origin and,
    // if the finger drifts past TOUCH_SLOP, cancel the click that the browser
    // would otherwise synthesize on touchend.
    const touchOriginRef = useRef<{ x: number, y: number } | null>(null);
    const touchMovedRef = useRef(false);

    const onTouchStart = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
        const t = event.touches[0];
        touchOriginRef.current = t ? { x: t.clientX, y: t.clientY } : null;
        touchMovedRef.current = false;
    }, []);

    const onTouchMove = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
        const origin = touchOriginRef.current;
        const t = event.touches[0];
        if (origin && t) {
            const dx = t.clientX - origin.x;
            const dy = t.clientY - origin.y;
            if (dx * dx + dy * dy > TOUCH_SLOP * TOUCH_SLOP) {
                touchMovedRef.current = true;
            }
        }
    }, []);

    const onClickCapture = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
        if (touchMovedRef.current) {
            // Scroll gesture — swallow the click so the anchor doesn't navigate.
            event.preventDefault();
            event.stopPropagation();
            touchMovedRef.current = false;
        }
    }, []);

    const touchProps = isMobile ? { onTouchStart, onTouchMove, onClickCapture } : {};

    const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
        if (typeof props.onKeyDown === 'function') {
            props.onKeyDown(event);
        }

        if (event.key === 'Enter') {
            event.preventDefault();
            // @ts-expect-error: Property 'buttonClickPrevented' does not exist on type 'KeyboardEvent'.
            if (!event.nativeEvent.buttonClickPrevented) {
                event.currentTarget.click();
            }
        }
    }, [props.onKeyDown]);

    const onMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
        if (typeof props.onMouseDown === 'function') {
            props.onMouseDown(event);
        }

        // @ts-expect-error: Property 'buttonBlurPrevented' does not exist on type 'MouseEvent'.
        if (!event.nativeEvent.buttonBlurPrevented) {
            event.preventDefault();
            if (document.activeElement instanceof HTMLElement) {
                document.activeElement.blur();
            }
        }
    }, [props.onMouseDown]);

    return createElement(
        typeof href === 'string' && href.length > 0 ? 'a' : 'div',
        {
            tabIndex: 0,
            ...props,
            ref,
            className: classNames(className, styles['button-container'], { 'disabled': disabled }),
            href,
            onKeyDown,
            onMouseDown,
            onDoubleClick,
            ...touchProps,
            ...longPress()
        },
        children
    );
});

export default Button;

