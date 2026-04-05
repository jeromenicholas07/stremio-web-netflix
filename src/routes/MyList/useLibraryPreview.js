// Hook that returns the user's library items as a preview catalog.
// Uses the core's LibraryWithFilters model to get recently added/watched items.

const { useModelState } = require('stremio/common');
const React = require('react');

const useLibraryPreview = () => {
    const action = React.useMemo(() => ({
        action: 'Load',
        args: {
            model: 'LibraryWithFilters',
            args: {
                request: {
                    type: null,
                    sort: undefined,
                }
            }
        }
    }), []);
    const library = useModelState({ model: 'library', action });
    return library;
};

module.exports = useLibraryPreview;
