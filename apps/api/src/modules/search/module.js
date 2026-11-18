import { searchRoutes } from './routes.js';
import { handleSearchEvent } from './handlers.js';

// Global search (Ctrl/Cmd+K) over deals, contacts and institutes, from search_documents. Results
// follow the same visibility rules as the records, so there are no search permissions of its own.
// Documents are written by producers through core/crm/search.js; this module serves the search
// endpoint, repairs documents from domain events and owns the reindex CLI.
// Built by the search slice; see docs/crm/PHASE2_CONTRACT.md.

export default {
  name: 'search',
  label: 'Search',
  // One catch-all handler that follows deal.*, contact.*, account.*, pipeline_stage.updated|archived
  // and product_line.updated (the registry matches exact types or '*'); see handlers.js.
  eventHandlers: { '*': handleSearchEvent },
  // Endpoints: docs/crm/PHASE2_CONTRACT.md §9.10 (GET /search); the reindex CLI is src/cli/search-reindex.js.
  routes: (router) => searchRoutes(router),
};
