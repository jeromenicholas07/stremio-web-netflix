const React = require('react');
const classnames = require('classnames');
const styles = require('./PinDialog.less');

const PIN_LENGTH = 4;

const PinDialog = React.memo(({ mode, onCreatePin, onVerifyPin }) => {
    const [digits, setDigits] = React.useState([]);
    const [confirmDigits, setConfirmDigits] = React.useState(null);
    const [error, setError] = React.useState('');
    const [shaking, setShaking] = React.useState(false);
    const [phase, setPhase] = React.useState(mode === 'create' ? 'enter' : 'verify');

    const activeDigits = phase === 'confirm' ? confirmDigits : digits;

    const triggerShake = React.useCallback(() => {
        setShaking(true);
        setTimeout(() => setShaking(false), 500);
    }, []);

    const handleDigit = React.useCallback((digit) => {
        const setter = phase === 'confirm' ? setConfirmDigits : setDigits;
        const current = phase === 'confirm' ? confirmDigits : digits;

        if (current.length >= PIN_LENGTH) return;
        const next = [...current, digit];
        setter(next);

        if (next.length === PIN_LENGTH) {
            setTimeout(() => {
                if (mode === 'create') {
                    if (phase === 'enter') {
                        setPhase('confirm');
                        setConfirmDigits([]);
                        setError('');
                    } else if (phase === 'confirm') {
                        const pin1 = digits.join('');
                        const pin2 = next.join('');
                        if (pin1 === pin2) {
                            onCreatePin(pin1);
                        } else {
                            setError('PINs do not match. Try again.');
                            triggerShake();
                            setDigits([]);
                            setConfirmDigits(null);
                            setPhase('enter');
                        }
                    }
                } else {
                    const pin = next.join('');
                    onVerifyPin(pin).then(success => {
                        if (!success) {
                            setError('Wrong PIN. Try again.');
                            triggerShake();
                            setter([]);
                        }
                    });
                }
            }, 150);
        }
    }, [phase, digits, confirmDigits, mode, onCreatePin, onVerifyPin, triggerShake]);

    const handleBackspace = React.useCallback(() => {
        const setter = phase === 'confirm' ? setConfirmDigits : setDigits;
        const current = phase === 'confirm' ? confirmDigits : digits;
        if (current.length > 0) {
            setter(current.slice(0, -1));
            setError('');
        }
    }, [phase, digits, confirmDigits]);

    // Keyboard support
    React.useEffect(() => {
        const onKeyDown = (event) => {
            if (event.key >= '0' && event.key <= '9') {
                handleDigit(parseInt(event.key, 10));
            } else if (event.key === 'Backspace') {
                handleBackspace();
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [handleDigit, handleBackspace]);

    const title = mode === 'create'
        ? (phase === 'confirm' ? 'Confirm Your PIN' : 'Create a PIN')
        : 'Enter PIN';

    const subtitle = mode === 'create' && phase === 'enter'
        ? 'Choose a 4-digit PIN to protect this section'
        : mode === 'create' && phase === 'confirm'
            ? 'Re-enter the same PIN to confirm'
            : '';

    const currentDisplay = phase === 'confirm' ? (confirmDigits || []) : digits;

    return (
        <div className={styles['pin-dialog-container']}>
            <div className={styles['pin-dialog-content']}>
                <div className={styles['pin-title']}>{title}</div>
                {subtitle ? <div className={styles['pin-subtitle']}>{subtitle}</div> : null}
                <div className={classnames(styles['pin-dots-container'], { [styles['shake']]: shaking })}>
                    {Array.from({ length: PIN_LENGTH }).map((_, i) => (
                        <div
                            key={i}
                            className={classnames(styles['pin-dot'], {
                                [styles['filled']]: i < currentDisplay.length,
                            })}
                        />
                    ))}
                </div>
                <div className={styles['pin-error']}>{error}</div>
                <div className={styles['pin-numpad']}>
                    {[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => (
                        <button
                            key={n}
                            className={styles['numpad-button']}
                            onClick={() => handleDigit(n)}
                            type="button"
                        >
                            {n}
                        </button>
                    ))}
                    <button className={classnames(styles['numpad-button'], styles['empty-button'])} type="button" />
                    <button
                        className={styles['numpad-button']}
                        onClick={() => handleDigit(0)}
                        type="button"
                    >
                        0
                    </button>
                    <button
                        className={classnames(styles['numpad-button'], styles['backspace-button'])}
                        onClick={handleBackspace}
                        type="button"
                    >
                        &#9003;
                    </button>
                </div>
            </div>
        </div>
    );
});

PinDialog.displayName = 'PinDialog';

module.exports = PinDialog;
