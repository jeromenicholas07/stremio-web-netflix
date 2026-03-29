// Copyright (C) 2017-2023 Smart code 203358507

const EventEmitter = require('eventemitter3');

const QtMsgTypes = {
    signal: 1,
    propertyUpdate: 2,
    init: 3,
    idle: 4,
    debug: 5,
    invokeMethod: 6,
    connectToSignal: 7,
    disconnectFromSignal: 8,
    setProperty: 9,
    response: 10,
};
const QtObjId = 'transport'; // the ID of our transport object

function ShellTransport() {
    const events = new EventEmitter();

    this.props = {};

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const shell = this;

    // Try Qt WebChannel first (old shell / shell-ng compat layer), then WebView2 direct
    const qtTransport = window.qt && window.qt.webChannelTransport;
    const webviewTransport = typeof globalThis !== 'undefined' && globalThis.chrome && globalThis.chrome.webview;

    console.log('[ShellTransport] init — qt:', !!qtTransport, 'webview2:', !!webviewTransport);

    if (qtTransport) {
        // ─── Qt WebChannel transport (legacy shell) ───
        let id = 0;
        function send(msg) {
            msg.id = id++;
            qtTransport.send(JSON.stringify(msg));
        }

        qtTransport.onmessage = function (message) {
            const msg = JSON.parse(message.data);
            if (msg.id === 0) {
                const obj = msg.data[QtObjId];

                obj.properties.slice(1).forEach(function (prop) {
                    shell.props[prop[1]] = prop[3];
                });
                if (typeof shell.props.shellVersion === 'string') {
                    shell.shellVersionArr = (
                        shell.props.shellVersion.match(/(\d+)\.(\d+)\.(\d+)/) || []
                    )
                        .slice(1, 4)
                        .map(Number);
                }
                events.emit('received-props', shell.props);

                obj.signals.forEach(function (sig) {
                    send({
                        type: QtMsgTypes.connectToSignal,
                        object: QtObjId,
                        signal: sig[1],
                    });
                });

                const onEvent = obj.methods.filter(function (x) {
                    return x[0] === 'onEvent';
                })[0];

                shell.send = function (ev, args) {
                    send({
                        type: QtMsgTypes.invokeMethod,
                        object: QtObjId,
                        method: onEvent[1],
                        args: [ev, args || {}],
                    });
                };

                console.log('[ShellTransport] handshake complete — shellVersion:', shell.props.shellVersion, 'methods:', obj.methods);
                shell.send('app-ready', {}); // signal that we're ready to take events
            }

            if (msg.object === QtObjId && msg.type === QtMsgTypes.signal)
                events.emit(msg.args[0], msg.args[1]);
        };
        send({ type: QtMsgTypes.init });

    } else if (webviewTransport) {
        // ─── WebView2 transport (stremio-shell-ng) ───
        let msgId = 0;

        shell.send = function (ev, args) {
            webviewTransport.postMessage(JSON.stringify({
                id: msgId++,
                type: QtMsgTypes.invokeMethod,
                object: QtObjId,
                method: 'onEvent',
                args: [ev, args || {}],
            }));
        };

        webviewTransport.addEventListener('message', function (message) {
            try {
                const msg = JSON.parse(message.data);
                if (msg.type === QtMsgTypes.signal) {
                    const methodName = Array.isArray(msg.args) ? msg.args[0] : null;
                    const methodArg = Array.isArray(msg.args) ? msg.args[1] : null;
                    if (methodName) {
                        events.emit(methodName, methodArg);
                    }
                }
            } catch (e) {
                console.error('ShellTransport WebView2 message error:', e);
            }
        });

        shell.send('app-ready', {});

    } else {
        throw 'no viable transport found (qt.webChannelTransport or chrome.webview)';
    }

    this.on = function(name, listener) {
        events.on(name, listener);
    };
    this.off = function(name, listener) {
        events.off(name, listener);
    };
    this.removeAllListeners = function() {
        events.removeAllListeners();
    };
}

module.exports = ShellTransport;
