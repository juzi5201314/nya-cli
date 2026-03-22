## Remote Git Credential Safety

- Remote git clone/fetch must use a network-safe URL derived from the source locator.
- Strip userinfo credentials and redact sensitive query/fragment values before any git subprocess runs.
- `normalizeLocatorForStorage()` now preserves fragment key structure and redacts fragment values in place.
- Regression tests should scan cached `.git/config` and `.git/logs/**` to ensure raw credential substrings never appear.
