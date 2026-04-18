// Copyright (C) 2017-2023 Smart code 203358507

const routesRegexp = {
    intro: {
        regexp: /^\/intro$/,
        urlParamsNames: []
    },
    board: {
        regexp: /^\/?(?:board)?$/,
        urlParamsNames: []
    },
    discover: {
        regexp: /^\/discover(?:\/([^/]*)\/([^/]*)\/([^/]*))?$/,
        urlParamsNames: ['transportUrl', 'type', 'catalogId']
    },
    library: {
        regexp: /^\/library(?:\/([^/]*))?$/,
        urlParamsNames: ['type']
    },
    calendar: {
        regexp: /^\/calendar(?:\/([^/]*)\/([^/]*))?$/,
        urlParamsNames: ['year', 'month']
    },
    mylist: {
        regexp: /^\/mylist$/,
        urlParamsNames: []
    },
    continuewatching: {
        regexp: /^\/continuewatching(?:\/([^/]*))?$/,
        urlParamsNames: ['type']
    },
    search: {
        regexp: /^\/search$/,
        urlParamsNames: []
    },
    metadetails: {
        regexp: /^\/(?:metadetails|detail)\/([^/]*)\/([^/]*)(?:\/([^/]*))?$/,
        urlParamsNames: ['type', 'id', 'videoId']
    },
    addons: {
        regexp: /^\/addons(?:\/([^/]*)(?:\/([^/]*)\/([^/]*))?)?$/,
        urlParamsNames: ['type', 'transportUrl', 'catalogId']
    },
    settings: {
        regexp: /^\/settings$/,
        urlParamsNames: []
    },
    player: {
        regexp: /^\/player\/([^/]*)(?:\/([^/]*)\/([^/]*)\/([^/]*)\/([^/]*)\/([^/]*))?$/,
        urlParamsNames: ['stream', 'streamTransportUrl', 'metaTransportUrl', 'type', 'id', 'videoId']
    },
    incognito: {
        regexp: /^\/incognito(?:\/(details|search)\/([^/]+))?$/,
        urlParamsNames: ['subpage', 'subpageArg']
    }
};

module.exports = routesRegexp;
