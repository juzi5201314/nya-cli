# Search

Current search pipeline notes.

- Vector search applies suffix filtering after its inner top-N limit, so `--ext` can underfill unless the vector candidate pool is oversampled.
- FTS suffix filtering is applied before its limit, so its candidate pool behaves differently from vector search under the same `--ext` filter.
- Because the retrievers are asymmetric, hybrid ranking and final truncation need explicit care to stay deterministic and avoid missing valid suffix-matching hits.
- Vector retriever tie ordering must be stabilized before the inner `LIMIT`; adding a secondary sort only after the limit is too late for equal-distance candidates.
