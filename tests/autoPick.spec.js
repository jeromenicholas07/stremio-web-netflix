// Copyright (C) 2017-2026 Smart code 203358507

const autoPick = require('../src/common/autoPick');

function createStorageMock() {
    const storage = {};
    return {
        getItem: jest.fn((key) => storage[key] || null),
        setItem: jest.fn((key, value) => {
            storage[key] = String(value);
        }),
        removeItem: jest.fn((key) => {
            delete storage[key];
        }),
        clear: jest.fn(() => {
            Object.keys(storage).forEach((key) => delete storage[key]);
        }),
    };
}

function stream({ addonName = 'Torrentio', name, description = '', player = name }) {
    return {
        addonName,
        name,
        description,
        deepLinks: {
            player,
        },
    };
}

// Builds a settings object enabling only `enabledKeys` (in priority order),
// with every other catalog key present but disabled.
function priority(catalog, enabledKeys) {
    const allKeys = catalog.map(({ key }) => key);
    const rest = allKeys.filter((key) => !enabledKeys.includes(key));
    return [...enabledKeys, ...rest].map((key) => ({ key, enabled: enabledKeys.includes(key) }));
}

const ALL_QUALITIES = autoPick.QUALITIES.map(({ key }) => key);

function makeSettings(sourceKeys, qualityKeys = ALL_QUALITIES) {
    return {
        enabled: true,
        sources: priority(autoPick.SOURCES, sourceKeys),
        qualities: priority(autoPick.QUALITIES, qualityKeys),
    };
}

describe('autoPick', () => {
    beforeEach(() => {
        global.localStorage = createStorageMock();
        global.sessionStorage = createStorageMock();
    });

    it('migrates legacy per-show overrides into the ordered model', () => {
        autoPick.setGlobalAutoPickSettings({
            enabled: true,
            quality: '4k',
            fallback: '1080p',
            source: 'realdebrid',
        });

        autoPick.setAutoPickOverride('series', 'tt123', {
            enabled: true,
            quality: '720p',
            fallback: '480p',
            source: 'torrentio',
        });

        const effective = autoPick.getEffectiveAutoPickSettings('series', 'tt123');
        expect(effective.enabled).toBe(true);
        // Legacy preferred quality lands first in the priority list.
        expect(effective.qualities[0].key).toBe('720p');
        expect(effective.qualities[1].key).toBe('480p');
        // Only the migrated source is enabled; the rest are available but off.
        expect(effective.sources.find(({ key }) => key === 'torrentio').enabled).toBe(true);
        expect(effective.sources.find(({ key }) => key === 'rd_plus').enabled).toBe(false);
    });

    it('classifies RealDebrid cached vs download and Torrentio sources', () => {
        expect(autoPick.streamSourceKeys(stream({ name: '[RD+] 1080p' }))).toContain('rd_plus');
        expect(autoPick.streamSourceKeys(stream({ name: '[RD download] 1080p' }))).toContain('rd_download');
        expect(autoPick.streamSourceKeys(stream({ addonName: 'Other', name: '1080p' }))).toEqual(['other']);
    });

    it('picks by source priority first, then quality', () => {
        const settings = makeSettings(['rd_plus', 'torrentio']);
        const streams = [
            stream({ addonName: 'Other', name: '1080p', player: 'other' }),
            stream({ name: '[RD+] 720p', player: 'rd-720' }),
            stream({ name: '[RD+] 1080p', description: '\uD83D\uDC64 35', player: 'rd-1080' }),
        ];

        expect(autoPick.pickBestStream(streams, settings).deepLinks.player).toBe('rd-1080');
    });

    it('excludes failed streams and falls through to the next best', () => {
        const settings = makeSettings(['rd_plus']);
        const failed = stream({ name: '[RD+] 1080p A', player: 'failed' });
        const nextSameQuality = stream({ name: '[RD+] 1080p B', player: 'same-quality' });
        const lowerQuality = stream({ name: '[RD+] 720p', player: 'lower-quality' });

        const picked = autoPick.pickBestStream([failed, lowerQuality, nextSameQuality], settings, {
            failedStreamKeys: [autoPick.getStreamKey(failed)],
        });

        expect(picked.deepLinks.player).toBe('same-quality');
    });

    it('steps down a quality when no same-quality stream remains', () => {
        const settings = makeSettings(['rd_plus']);
        const failed = stream({ name: '[RD+] 1080p A', player: 'failed' });
        const lowerQuality = stream({ name: '[RD+] 720p', player: 'lower-quality' });

        const picked = autoPick.pickBestStream([failed, lowerQuality], settings, {
            failedStreamKeys: [autoPick.getStreamKey(failed)],
        });

        expect(picked.deepLinks.player).toBe('lower-quality');
    });

    it('prefers a higher quality over a higher-priority source (no SD over 1080p)', () => {
        // Regression (BoJack S03E12): rd_plus was the top source but only had
        // SD/`other` English streams, while 1080p was available from rd_download.
        // Source-dominant ranking wrongly played the SD rd_plus stream. Diagonal
        // ranking must pick the 1080p download instead.
        const settings = makeSettings(['rd_plus', 'rd_download', 'torrentio']);
        const rdPlusSd = stream({
            addonName: 'Torrentio RD',
            name: '[RD+] Torrentio',
            description: 'BoJack Horseman Seasons 1-6\nBoJack.Horseman.S03E12.That.Went.Well.mp4\n\uD83D\uDC64 11 \uD83D\uDCBE 84.77 MB \u2699\uFE0F ThePirateBay',
            player: 'rdplus-sd',
        });
        const rdDownloadHd = stream({
            addonName: 'Torrentio RD',
            name: '[RD download] Torrentio 1080p',
            description: 'BoJack Horseman S01-S06 Complete [WEBRip-1080p x265]\nBoJack Horseman - S03E12.mkv\n\uD83D\uDC64 5 \uD83D\uDCBE 300 MB \u2699\uFE0F EZTV',
            player: 'rddl-1080',
        });

        const best = autoPick.pickBestStream([rdPlusSd, rdDownloadHd], settings);
        expect(best.deepLinks.player).toBe('rddl-1080');
        expect(autoPick.describeStream(best, settings).qualityLabel).toBe('1080p');
    });

    it('still prefers the better source when quality is equal', () => {
        const settings = makeSettings(['rd_plus', 'rd_download', 'torrentio']);
        const rdPlus = stream({ name: '[RD+] Torrentio 1080p', description: 'WEB H264', player: 'rdplus' });
        const rdDownload = stream({ name: '[RD download] Torrentio 1080p', description: 'WEB H264', player: 'rddl' });

        expect(autoPick.pickBestStream([rdDownload, rdPlus], settings).deepLinks.player).toBe('rdplus');
    });

    it('prefers a debrid stream over a P2P stream at the same quality', () => {
        const settings = makeSettings(['rd_download', 'torrentio']);
        const rdDownload = stream({ name: '[RD download] Torrentio 1080p', description: 'WEB H264', player: 'rddl' });
        const p2p = stream({ addonName: 'Torrentio', name: 'Torrentio 1080p', description: 'WEB H264', player: 'p2p' });

        expect(autoPick.pickBestStream([p2p, rdDownload], settings).deepLinks.player).toBe('rddl');
    });

    it('skips disabled sources entirely', () => {
        const settings = makeSettings(['torrentio']);
        const streams = [
            stream({ addonName: 'Torrentio', name: '[RD+] 1080p', player: 'rd' }),
        ];
        // The only stream is RD+ from a Torrentio addon, so it still matches the
        // enabled torrentio bucket and plays.
        expect(autoPick.pickBestStream(streams, settings).deepLinks.player).toBe('rd');

        const onlyOther = [stream({ addonName: 'SomeOtherAddon', name: '1080p', player: 'plain' })];
        expect(autoPick.pickBestStream(onlyOther, settings)).toBe(null);
    });

    it('detects available qualities from loaded streams', () => {
        const availability = autoPick.detectAvailability([
            stream({ name: '[RD+] 1080p' }),
            stream({ name: '[RD download] 1080p' }),
            stream({ name: '[RD+] 720p' }),
        ]);

        expect(availability.qualities['1080p']).toBe(2);
        expect(availability.qualities['720p']).toBe(1);
        expect(availability.sources['rd_plus']).toBe(2);
        expect(availability.sources['rd_download']).toBe(1);
    });

    it('detects foreign-language releases by flag emoji and tags', () => {
        expect(autoPick.detectIsForeign(stream({
            name: '[RD+] Torrentio 1080p',
            description: 'Curb ... 1080p AV1 Opus ITA (repack) \uD83C\uDDEE\uD83C\uDDF9',
        }))).toBe(true);
        // Plain English scene release: no foreign markers.
        expect(autoPick.detectIsForeign(stream({
            name: 'Torrentio 1080p',
            description: 'Curb Your Enthusiasm S12E01 REPACK 1080p WEB H264-NHTFS',
        }))).toBe(false);
        // MULTi / explicit ENG is whitelisted even if a foreign tag is present.
        expect(autoPick.detectIsForeign(stream({
            name: 'Torrentio 1080p',
            description: 'Show S01E01 ITA ENG 1080p',
        }))).toBe(false);
    });

    it('excludes foreign-language streams when englishOnly is set', () => {
        const settings = { ...makeSettings(['rd_plus', 'torrentio']), englishOnly: true };
        const ita = stream({ name: '[RD+] 1080p', description: 'Opus ITA \uD83C\uDDEE\uD83C\uDDF9', player: 'ita' });
        const eng = stream({ name: '[RD download] 1080p', description: 'WEB H264-NHTFS', player: 'eng' });

        expect(autoPick.pickBestStream([ita, eng], settings).deepLinks.player).toBe('eng');

        const noFilter = { ...settings, englishOnly: false };
        expect(autoPick.pickBestStream([ita, eng], noFilter).deepLinks.player).toBe('ita');
    });

    it('waits while stream addons are still loading', () => {
        expect(autoPick.isWaitingForStreamsToLoad(2)).toBe(true);
        expect(autoPick.isWaitingForStreamsToLoad(0)).toBe(false);
    });

    it('numbers auto-pick attempts by visible list order', () => {
        const settings = makeSettings(['rd_download', 'torrentio']);
        const rd1 = stream({ name: '[RD download] 1080p', description: 'A', player: 'rd1' });
        const rd2 = stream({ name: '[RD download] 1080p', description: 'B', player: 'rd2' });
        const plain = stream({ name: 'Torrentio 1080p', player: 'plain' });
        const list = [rd1, rd2, plain];

        expect(autoPick.getStreamAttemptNumber(list, rd1)).toBe(1);
        expect(autoPick.getStreamAttemptNumber(list, rd2)).toBe(2);
        expect(autoPick.getStreamAttemptNumber(list, plain)).toBe(3);
    });

    it('keeps addon list order for equal-ranked candidates', () => {
        const settings = makeSettings(['rd_download', 'torrentio']);
        const rd1 = stream({ name: '[RD download] 1080p', description: 'A', player: 'rd1' });
        const rd2 = stream({ name: '[RD download] 1080p', description: 'B', player: 'rd2' });

        expect(autoPick.getAutoPickCandidates([rd1, rd2], settings).map((s) => s.deepLinks.player)).toEqual(['rd1', 'rd2']);
    });

    it('does not treat the "Torrent" tracker token as a purchasable stream', () => {
        // Regression: the purchasable filter used /rent/ without word boundaries,
        // so "TorrentGalaxy" (contains "rent") was wrongly excluded from ranking.
        const settings = makeSettings(['rd_download', 'torrentio']);
        const galaxy = stream({
            name: '[RD download] 1080p',
            description: 'Show S12E01 1080p x265-MeGusta \uD83D\uDC64 25 \u2699\uFE0F TorrentGalaxy',
            player: 'galaxy',
        });

        expect(autoPick.rankStream(galaxy, settings)).not.toBeNull();
        expect(autoPick.getAutoPickCandidates([galaxy], settings)).toHaveLength(1);
    });

    it('still excludes genuinely purchasable streams', () => {
        const settings = makeSettings(['rd_download', 'torrentio']);
        const rent = stream({ name: 'Cinema 1080p', description: 'Rent or buy in HD', player: 'rent' });

        expect(autoPick.rankStream(rent, settings)).toBeNull();
    });

    it('formats copyright skip summary for the banner', () => {
        expect(autoPick.formatAutoPickSkipSummary(0)).toBe(null);
        expect(autoPick.formatAutoPickSkipSummary(1)).toBe('Skipped 1 copyright-blocked stream first');
        expect(autoPick.formatAutoPickSkipSummary(2)).toBe('Skipped 2 copyright-blocked streams first');
    });

    it('exposes human-readable labels', () => {
        expect(autoPick.getQualityLabel('1080p')).toBe('1080p');
        expect(autoPick.getSourceLabel('rd_plus')).toBe('RealDebrid (cached)');
    });

    it('detects recoverable unavailable and copyright errors', () => {
        expect(autoPick.isRecoverableAutoPickError({
            message: 'Stream is unavailable',
        })).toBe(true);
        expect(autoPick.isRecoverableAutoPickError({
            message: 'file was removed from debrid service due to copyright',
        })).toBe(true);
        expect(autoPick.isRecoverableAutoPickError({
            message: 'some random playback glitch',
        })).toBe(false);
    });

    it('clears a single persisted failure without wiping the rest', () => {
        autoPick.recordAutoPickFailure({
            type: 'series',
            metaId: 'tt123',
            videoId: 'tt123:1:1',
            streamKey: 'stream-a',
            quality: '1080p',
        }, 'copyright');
        autoPick.recordAutoPickFailure({
            type: 'series',
            metaId: 'tt123',
            videoId: 'tt123:1:1',
            streamKey: 'stream-b',
            quality: '1080p',
        }, 'unavailable');

        autoPick.clearAutoPickFailure('series', 'tt123', 'tt123:1:1', 'stream-a');

        const failures = autoPick.getAutoPickFailures('series', 'tt123', 'tt123:1:1');
        expect(failures).toHaveLength(1);
        expect(failures[0].streamKey).toBe('stream-b');
    });
});
