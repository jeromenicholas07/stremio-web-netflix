const React = require('react');
const classnames = require('classnames');
const { default: Icon } = require('@stremio/stremio-icons/react');
const styles = require('./IncognitoSearchBar.less');

const IncognitoSearchBar = React.memo(({ className, onSearch }) => {
    const [value, setValue] = React.useState('');
    const debounceRef = React.useRef(null);

    const handleChange = React.useCallback((event) => {
        const newValue = event.target.value;
        setValue(newValue);

        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => {
            onSearch(newValue);
        }, 400);
    }, [onSearch]);

    const handleClear = React.useCallback(() => {
        setValue('');
        onSearch('');
    }, [onSearch]);

    const handleKeyDown = React.useCallback((event) => {
        if (event.key === 'Enter') {
            if (debounceRef.current) clearTimeout(debounceRef.current);
            onSearch(value);
        }
    }, [value, onSearch]);

    React.useEffect(() => {
        return () => {
            if (debounceRef.current) clearTimeout(debounceRef.current);
        };
    }, []);

    return (
        <div className={classnames(className, styles['search-bar-container'])}>
            <Icon className={styles['search-icon']} name={'search'} />
            <input
                className={styles['search-input']}
                type="text"
                placeholder="Search..."
                value={value}
                onChange={handleChange}
                onKeyDown={handleKeyDown}
                autoComplete="off"
                spellCheck={false}
            />
            {value.length > 0 ? (
                <button className={styles['clear-button']} onClick={handleClear} type="button">
                    <Icon name={'close'} />
                </button>
            ) : null}
        </div>
    );
});

IncognitoSearchBar.displayName = 'IncognitoSearchBar';

module.exports = IncognitoSearchBar;
