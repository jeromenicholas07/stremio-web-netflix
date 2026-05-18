const levenshtein = require('fast-levenshtein');
const crypto = require('crypto');
const { getConfig } = require('./config');

// Quality tags to strip during normalization
const QUALITY_TAGS = /\b(2160p|1080p|720p|480p|360p|4k|uhd|hd|sd|x264|x265|h264|h265|hevc|avc|bluray|blu-ray|bdrip|brrip|webrip|web-dl|webdl|dvdrip|hdtv|hdrip|remux|10bit|8bit|aac|ac3|dts|mp4|mkv|avi|wmv)\b/gi;

// Common uploader/site tags to strip
const SITE_TAGS = /\[([^\]]+)\]|\(([^)]+)\)/g;

// File extensions
const FILE_EXT = /\.(mp4|mkv|avi|wmv|mov|flv|webm|ts)$/i;

// Common separator patterns
const SEPARATORS = /[._-]+/g;

/**
 * Normalize a torrent title for comparison.
 */
function normalizeTitle(title) {
    let normalized = title;

    // Remove file extension
    normalized = normalized.replace(FILE_EXT, '');

    // Remove bracketed content (often site names, uploader tags)
    normalized = normalized.replace(SITE_TAGS, ' ');

    // Remove quality tags
    normalized = normalized.replace(QUALITY_TAGS, ' ');

    // Replace separators with spaces
    normalized = normalized.replace(SEPARATORS, ' ');

    // Collapse whitespace and trim
    normalized = normalized.replace(/\s+/g, ' ').trim().toLowerCase();

    return normalized;
}

/**
 * Extract quality info from a title.
 */
function extractQuality(title) {
    const t = title.toUpperCase();
    if (t.includes('2160P') || t.includes('4K') || t.includes('UHD')) return '4K';
    if (t.includes('1080P') || t.includes('FHD')) return '1080p';
    if (t.includes('720P')) return '720p';
    if (t.includes('480P')) return '480p';
    return 'Unknown';
}

/**
 * Calculate similarity ratio between two strings (0-1).
 */
function similarity(a, b) {
    if (a === b) return 1;
    const maxLen = Math.max(a.length, b.length);
    if (maxLen === 0) return 1;
    const dist = levenshtein.get(a, b);
    return 1 - (dist / maxLen);
}

/**
 * Generate a stable ID for a group of similar items.
 */
function generateGroupId(normalizedTitle) {
    return 'adult-' + crypto.createHash('md5').update(normalizedTitle).digest('hex').slice(0, 12);
}

/**
 * Stable short fingerprint for items that lack a resolvable infoHash —
 * used as a dedupe key (and baked into encoded ids for lazy resolution).
 * Lives here in the shared utils module so catalog.js, torrentSearch.js
 * and hybridSearch.js can all reuse it without a circular require.
 */
function fingerprint(downloadUrl, title) {
    const seed = `${downloadUrl || ''}|${title || ''}`;
    let h = 5381;
    for (let i = 0; i < seed.length; i++) {
        h = ((h << 5) + h + seed.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Format file size for display.
 */
function formatSize(bytes) {
    if (!bytes || bytes === 0) return '';
    const gb = bytes / (1024 * 1024 * 1024);
    if (gb >= 1) return `${gb.toFixed(1)} GB`;
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(0)} MB`;
}

/**
 * Deduplicate and group an array of torrent items.
 * Returns an array of group objects, each representing one unique video.
 *
 * @param {Array} items - Raw torrent items from Prowlarr
 * @returns {Array} Grouped items with variants
 */
function deduplicateItems(items) {
    const config = getConfig();
    const threshold = config.dedupThreshold;

    // Normalize all items
    const normalized = items.map(item => ({
        ...item,
        normalizedTitle: normalizeTitle(item.title),
        quality: extractQuality(item.title),
    }));

    // Group by similarity
    const groups = [];
    const assigned = new Set();

    for (let i = 0; i < normalized.length; i++) {
        if (assigned.has(i)) continue;

        const group = [normalized[i]];
        assigned.add(i);

        for (let j = i + 1; j < normalized.length; j++) {
            if (assigned.has(j)) continue;

            const sim = similarity(normalized[i].normalizedTitle, normalized[j].normalizedTitle);
            if (sim >= threshold) {
                group.push(normalized[j]);
                assigned.add(j);
            }
        }

        groups.push(group);
    }

    // Convert groups to output format
    return groups.map(group => {
        // Sort variants: most seeders first
        group.sort((a, b) => b.seeders - a.seeders);
        const representative = group[0];

        // Build unique quality variants (dedup by quality)
        const qualityMap = new Map();
        for (const item of group) {
            const key = item.quality;
            if (!qualityMap.has(key) || item.seeders > qualityMap.get(key).seeders) {
                qualityMap.set(key, item);
            }
        }

        const groupId = generateGroupId(representative.normalizedTitle);
        const variants = Array.from(qualityMap.entries()).map(([quality, item]) => ({
            id: `${groupId}:${quality}`,
            title: `${quality}${item.size ? ' (' + formatSize(item.size) + ')' : ''} - ${item.seeders} seeders`,
            quality,
            infoHash: item.infoHash,
            magnetUrl: item.magnetUrl,
            downloadUrl: item.downloadUrl,
            size: item.size,
            seeders: item.seeders,
            originalTitle: item.title,
        }));

        // Sort variants by quality preference
        const qualityOrder = { '4K': 0, '1080p': 1, '720p': 2, '480p': 3, 'Unknown': 4 };
        variants.sort((a, b) => (qualityOrder[a.quality] ?? 5) - (qualityOrder[b.quality] ?? 5));

        return {
            id: groupId,
            name: formatDisplayTitle(representative.normalizedTitle),
            poster: representative.poster || null,
            description: buildDescription(representative, group),
            pubDate: representative.pubDate,
            seeders: representative.seeders,
            variants,
            totalSources: group.length,
        };
    });
}

/**
 * Format a normalized title for display (title case).
 */
function formatDisplayTitle(normalizedTitle) {
    return normalizedTitle
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

/**
 * Build a description string for a grouped item.
 */
function buildDescription(representative, group) {
    const parts = [];
    const qualities = [...new Set(group.map(g => g.quality).filter(q => q !== 'Unknown'))];
    if (qualities.length > 0) {
        parts.push(`Available in: ${qualities.join(', ')}`);
    }
    parts.push(`${group.length} source${group.length > 1 ? 's' : ''} found`);
    if (representative.seeders > 0) {
        parts.push(`Best: ${representative.seeders} seeders`);
    }
    return parts.join(' | ');
}

module.exports = { deduplicateItems, normalizeTitle, extractQuality, generateGroupId, formatSize, fingerprint };
