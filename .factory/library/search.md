# Search

Current search pipeline notes.

- Vector search now applies suffix filtering before the vec0 inner top-N limit by constraining the candidate join inside the KNN query, so `--ext` searches can keep enough matching candidates even on tie-heavy boundary cases.
- FTS suffix filtering is applied before its limit, so its candidate pool behaves differently from vector search under the same `--ext` filter.
- Because the retrievers are still asymmetric, hybrid ranking and final truncation need explicit care to stay deterministic and avoid missing valid suffix-matching hits.
- vec0 may reject secondary `ORDER BY` keys inside the inner KNN subquery, so tie stability should be verified against the actual SQL shape; when that happens, use the filtered probe-and-expand fallback already in `src/db/database.ts`.
