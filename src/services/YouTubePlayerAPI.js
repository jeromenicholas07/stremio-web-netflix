// Copyright (C) 2017-2024 Smart code 203358507
// Loads YouTube IFrame API once and returns a promise

let apiReady = null;

function loadYouTubeAPI() {
    if (apiReady) return apiReady;

    if (window.YT && window.YT.Player) {
        apiReady = Promise.resolve(window.YT);
        return apiReady;
    }

    apiReady = new Promise((resolve) => {
        const prev = window.onYouTubeIframeAPIReady;
        window.onYouTubeIframeAPIReady = () => {
            if (typeof prev === 'function') prev();
            resolve(window.YT);
        };
        const script = document.createElement('script');
        script.src = 'https://www.youtube.com/iframe_api';
        document.head.appendChild(script);
    });

    return apiReady;
}

module.exports = { loadYouTubeAPI };
