# Query time semantics

Query timestamps are RFC3339 instants with seconds, an explicit `Z` or numeric offset, and at most nine fractional digits. Invalid calendar dates, leap seconds and more than nine fractional digits are rejected. `from` and timestamp `to` are inclusive. A date-only query is a UTC calendar day: `from` is inclusive midnight and `to` is exclusive next midnight. An invalid or reversed range is an error.

Source timestamps are preserved verbatim and their fractional digits are compared exactly, including fractions finer than milliseconds. Missing or unparseable source timestamps, including dates without a time zone, are unknown; a time filter cannot match them. Without a time filter they remain visible after known times. Results preserve the original version and citation. Equal instants compare equal irrespective of representation.

The web date controls use the browser's displayed local time zone. The start is local midnight, and the exclusive end is the following local midnight; a daylight-saving day may have 23 or 25 hours. These bounds are transmitted as UTC timestamps. This behavior does not alter stored source data.

SQLite applies the same parser as a deterministic function during scoped filtering. It cannot use the existing raw-string time index for that predicate and may scan the scoped projection; no bounded-scan or performance claim is made.
