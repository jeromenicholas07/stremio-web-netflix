// Copyright (C) 2017-2026 Smart code 203358507

import React, { useCallback, useState } from 'react';
import classNames from 'classnames';
import { Button, Toggle } from 'stremio/components';
import styles from './AutoPickEditor.less';

const {
    getQualityLabel,
    getSourceLabel,
} = require('stremio/common/autoPick');

type Item = { key: string; enabled: boolean };

type Value = {
    enabled: boolean;
    englishOnly?: boolean;
    sources: Item[];
    qualities: Item[];
};

type Availability = {
    sources: Record<string, number>;
    qualities: Record<string, number>;
};

type Props = {
    className?: string;
    value: Value;
    onChange: (next: Value) => void;
    availability?: Availability | null;
    showMasterToggle?: boolean;
};

type PriorityListProps = {
    title: string;
    hint: string;
    items: Item[];
    disabled?: boolean;
    labelFor: (key: string) => string;
    countFor?: (key: string) => number | undefined;
    onChange: (items: Item[]) => void;
};

const reorder = (items: Item[], from: number, to: number): Item[] => {
    if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) {
        return items;
    }
    const next = items.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    return next;
};

const PriorityList = ({ title, hint, items, disabled, labelFor, countFor, onChange }: PriorityListProps) => {
    const [dragIndex, setDragIndex] = useState<number | null>(null);
    const [overIndex, setOverIndex] = useState<number | null>(null);

    const commitReorder = useCallback((from: number, to: number) => {
        onChange(reorder(items, from, to));
    }, [items, onChange]);

    const toggleAt = useCallback((index: number) => {
        const next = items.slice();
        next[index] = { ...next[index], enabled: !next[index].enabled };
        onChange(next);
    }, [items, onChange]);

    const onDragStart = useCallback((index: number) => (event: React.DragEvent) => {
        if (disabled) return;
        setDragIndex(index);
        event.dataTransfer.effectAllowed = 'move';
        try {
            event.dataTransfer.setData('text/plain', String(index));
        } catch {
            // Some environments restrict setData; reorder still works via state.
        }
    }, [disabled]);

    const onDragOver = useCallback((index: number) => (event: React.DragEvent) => {
        if (disabled || dragIndex === null) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        setOverIndex(index);
    }, [disabled, dragIndex]);

    const onDrop = useCallback((index: number) => (event: React.DragEvent) => {
        if (disabled || dragIndex === null) return;
        event.preventDefault();
        commitReorder(dragIndex, index);
        setDragIndex(null);
        setOverIndex(null);
    }, [disabled, dragIndex, commitReorder]);

    const onDragEnd = useCallback(() => {
        setDragIndex(null);
        setOverIndex(null);
    }, []);

    return (
        <div className={classNames(styles['priority-list'], { [styles['disabled']]: disabled })}>
            <div className={styles['list-header']}>
                <div className={styles['list-title']}>{title}</div>
                <div className={styles['list-hint']}>{hint}</div>
            </div>
            <div className={styles['list-rows']}>
                {items.map((item, index) => {
                    const count = countFor ? countFor(item.key) : undefined;
                    const available = typeof count === 'number' && count > 0;
                    return (
                        <div
                            key={item.key}
                            className={classNames(styles['row'], {
                                [styles['row-disabled']]: !item.enabled,
                                [styles['row-dragging']]: dragIndex === index,
                                [styles['row-over']]: overIndex === index && dragIndex !== index,
                            })}
                            draggable={!disabled}
                            onDragStart={onDragStart(index)}
                            onDragOver={onDragOver(index)}
                            onDrop={onDrop(index)}
                            onDragEnd={onDragEnd}
                        >
                            <div className={styles['drag-handle']} title={'Drag to reorder'}>
                                <span className={styles['handle-dots']}>{'\u2630'}</span>
                                <span className={styles['rank']}>{index + 1}</span>
                            </div>
                            <div className={styles['row-label']}>
                                <span className={styles['row-name']}>{labelFor(item.key)}</span>
                                {
                                    countFor ?
                                        <span className={classNames(styles['row-count'], { [styles['row-count-empty']]: !available })}>
                                            {available ? `${count} available` : 'none here'}
                                        </span>
                                        :
                                        null
                                }
                            </div>
                            <div className={styles['row-actions']}>
                                <Button
                                    className={styles['move-button']}
                                    title={'Move up'}
                                    disabled={disabled || index === 0}
                                    onClick={() => commitReorder(index, index - 1)}
                                >
                                    {'\u25B2'}
                                </Button>
                                <Button
                                    className={styles['move-button']}
                                    title={'Move down'}
                                    disabled={disabled || index === items.length - 1}
                                    onClick={() => commitReorder(index, index + 1)}
                                >
                                    {'\u25BC'}
                                </Button>
                                <Button
                                    className={classNames(styles['enable-pill'], { [styles['enable-pill-on']]: item.enabled })}
                                    title={item.enabled ? 'Enabled — click to skip' : 'Disabled — click to enable'}
                                    disabled={disabled}
                                    onClick={() => toggleAt(index)}
                                >
                                    {item.enabled ? 'On' : 'Off'}
                                </Button>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
};

const AutoPickEditor = ({ className, value, onChange, availability, showMasterToggle = true }: Props) => {
    const onToggleEnabled = useCallback(() => {
        onChange({ ...value, enabled: !value.enabled });
    }, [value, onChange]);

    const onToggleEnglishOnly = useCallback(() => {
        onChange({ ...value, englishOnly: value.englishOnly === false });
    }, [value, onChange]);

    const onSourcesChange = useCallback((sources: Item[]) => {
        onChange({ ...value, sources });
    }, [value, onChange]);

    const onQualitiesChange = useCallback((qualities: Item[]) => {
        onChange({ ...value, qualities });
    }, [value, onChange]);

    const sourceCount = useCallback((key: string) => availability?.sources?.[key], [availability]);
    const qualityCount = useCallback((key: string) => availability?.qualities?.[key], [availability]);

    const lists = (
        <div className={classNames(styles['lists'], { [styles['lists-inactive']]: showMasterToggle && !value.enabled })}>
            <PriorityList
                title={'Sources'}
                hint={'Tried top to bottom. Turn off the ones you never want.'}
                items={value.sources}
                disabled={showMasterToggle && !value.enabled}
                labelFor={getSourceLabel}
                countFor={availability ? sourceCount : undefined}
                onChange={onSourcesChange}
            />
            <PriorityList
                title={'Quality'}
                hint={'Preferred quality first. Lower ones are used as fallback.'}
                items={value.qualities}
                disabled={showMasterToggle && !value.enabled}
                labelFor={getQualityLabel}
                countFor={availability ? qualityCount : undefined}
                onChange={onQualitiesChange}
            />
        </div>
    );

    return (
        <div className={classNames(className, styles['autopick-editor'])}>
            {
                showMasterToggle ?
                    <div className={styles['master-row']}>
                        <div className={styles['master-text']}>
                            <div className={styles['master-title']}>Auto-pick stream</div>
                            <div className={styles['master-subtitle']}>
                                {value.enabled ? 'Automatically plays the best available stream.' : 'Turn on to skip the stream list.'}
                            </div>
                        </div>
                        <Toggle
                            className={styles['master-toggle']}
                            checked={value.enabled}
                            onClick={onToggleEnabled}
                        />
                    </div>
                    :
                    null
            }
            <div className={classNames(styles['master-row'], styles['option-row'], { [styles['option-row-disabled']]: showMasterToggle && !value.enabled })}>
                <div className={styles['master-text']}>
                    <div className={styles['master-title']}>Prefer English audio</div>
                    <div className={styles['master-subtitle']}>
                        {'Foreign-language releases (e.g. ITA, \uD83C\uDDEE\uD83C\uDDF9) drop to the bottom of the list and are never auto-picked.'}
                    </div>
                </div>
                <Toggle
                    className={styles['master-toggle']}
                    checked={value.englishOnly !== false}
                    disabled={showMasterToggle && !value.enabled}
                    onClick={onToggleEnglishOnly}
                />
            </div>
            {lists}
        </div>
    );
};

export default AutoPickEditor;
