## This concerns https://github.com/charles-turner-1/xarray-ts/pull/31 — CF calendar decoding via `cftime-ts` (issue #30)

Generalises CF time-coordinate decoding beyond the three JS-`Date`-compatible calendars (`standard`, `gregorian`, `proleptic_gregorian`) to **all nine** CF calendars, by wiring in our own [`cftime-ts`](https://github.com/charles-turner-1/cftime-ts) port. Companion to the coords / rename / swap-dims notes. No local `~/xarray` checkout line numbers here — I'm citing function/file names only, they're landmarks not gospel (same caveat as the sibling docs).

**Where xarray does this**
- `xarray/coding/times.py` — `CFDatetimeCoder.decode` → `decode_cf_datetime(num_dates, units, calendar=None, use_cftime=None)`. The decision tree:
  - Standard/proleptic-Gregorian calendar **and** the values fit `datetime64[ns]` within pandas `Timestamp` bounds → decode to a NumPy `datetime64[ns]` array (`_decode_datetime_with_pandas`).
  - Otherwise — a **non-standard** calendar (`360_day`, `noleap`, `julian`, …) **or** out-of-range dates — fall back to `cftime` objects via `_decode_datetime_with_cftime`, which is a thin wrapper over `cftime.num2date(num_dates, units, calendar)`.
  - `use_cftime=True` forces cftime objects even for standard calendars; `use_cftime=False` forces `datetime64` and *raises* if not representable; `None` (default) picks per the tree above.
- The key xarray move: **the decoded objects replace the coordinate's values.** A cftime-backed time coordinate's `.values` *is* an array of `cftime.datetime`, and xarray builds a `CFTimeIndex` (`xarray/coding/cftimeindex.py`) so `.sel(time=cftime.DatetimeNoLeap(...))` / `.sel(time="2000-02")` work.

**How ours maps onto that — the deliberate divergence (primitives-plus-sidecar)**

xarray *swaps* `.values` to hold decoded objects (either `datetime64[ns]` or `cftime.datetime`). We **don't**: `Coord.values` stays **primitive** and the decoded objects live in a **sidecar accessor**. This is the one big design decision, taken with the issue's Stage 3 explicitly in mind.

- `src/decode/time.ts` `decodeTime(raw, attrs)` now returns `{ values, decoded, calendar, cftimes? }`:
  - `values` — unchanged. Epoch-**milliseconds** for standard calendars (our existing hand-rolled `parseTimeUnits` + `referenceMs + n*unitMs` arithmetic, kept as-is), or the **raw encoded numbers** for non-standard calendars (`decoded: false`).
  - `cftimes` — the sidecar: `num2date(raw.map(Number), units, { calendar })` from `cftime-ts`, run for **every** calendar it recognises (all nine), wrapped in `try/catch`. Unrecognised units/calendar → `undefined` (see the `weeks` note below).
  - `calendar` — the resolved lower-cased calendar name.
- `src/coords.ts` threads `cftimes`/`calendar` through `makeCoord` → the `Coord` gains `cftimes(): (CFDatetime | null)[] | undefined` and a `calendar` property, alongside the untouched `dates(): Date[] | undefined`. `renameCoord` rebinds `cftimes()` like it already does `dates()`.
- Net public shape (`src/types.ts`):
  - `values` — primitive, always (epoch-ms or raw numbers). *Never* holds objects.
  - `dates()` — JS `Date[]`, **only** for standard/proleptic calendars (`isTime && decoded`); `undefined` otherwise.
  - `cftimes()` — calendar-aware `CFDatetime[]` for *any* recognised CF calendar (this is the analogue of xarray's cftime `.values`), the sidecar for non-standard calendars.

Why sidecar instead of xarray's replace-values: our `values` is a plain `ReadonlyArray<number | bigint | string | boolean>` consumed synchronously by `.sel`, `sliceCoord`, repr, etc. Dropping `CFDatetime` objects into it would ripple a union type through all of those and force every numeric consumer to narrow. Keeping `values` primitive and offering `cftimes()` on the side is additive and leaves the standard-calendar fast path (and its exact epoch-ms behaviour, incl. pre-1582 dates) untouched.

**Standard-calendar subtlety (matches our existing `dates()` behaviour).** For `standard`, `cftime-ts` follows CF "standard" semantics = mixed Julian/Gregorian with the 1582 reform gap, while our `dates()`/`values` are proleptic-Gregorian JS `Date`. These agree for post-1582 dates (all real climate data) and can differ before 1582. That's the *same* trade our `dates()` already documented; `cftimes()` is the calendar-correct one if you care pre-1582.

**`weeks` corner.** Our epoch-ms `UNIT_MS` table supports `week`/`weeks`; `cftime-ts` (like Python `cftime`) does **not** — its units are `microseconds…days` (+ `months` for `360_day`, `common_years` for `noleap`). So a `"weeks since …"` standard coord decodes fine to epoch-ms (`decoded: true`) but `num2date` throws → `cftimes()` is `undefined`. Graceful degradation, covered by the `try/catch`. Non-standard `weeks` would be undecodable either way.

**`.sel()` on non-standard calendars (`src/indexing.ts`)** — the analogue of xarray's `CFTimeIndex.get_loc`.

Because our non-standard `values` are raw encoded numbers (not objects), we resolve labels by mapping them *into that raw number space* and reusing the existing numeric `lookupLabel` / `lookupLabelSlice` / `nearest` machinery unchanged:
- `labelToValue` gets a branch for a non-standard CF time coord (`coord.isTime && !coord.decoded && coord.cftimes()`): read `units`/`calendar` off `coord.attrs`, then
  - `CFDatetime` label → `date2num(label, units, { calendar })`;
  - ISO `string` → `parseDate(str)` field tuple → `new CFDatetime(...fields, { calendar })` → `date2num(...)`;
  - `number` → treated as an already-encoded value, returned as-is;
  - JS `Date` → throws (a proleptic `Date` is ambiguous on a non-standard calendar; the error tells you to pass a `CFDatetime`).
- `Label` widened to include `CFDatetime`; `isLabelSlice` now also excludes `CFDatetime` so a scalar datetime label isn't mistaken for a `{start?, stop?}` range.
- `DataArray.sel` / `Dataset.sel` themselves needed **no change** — they already delegate through `labelToValue`.
- `CFDatetime` is re-exported from the barrel **as a value** (the class, not just the type) so a consumer can build a `.sel` label without taking their own `cftime-ts` dependency.

**Public API impact.** Purely additive: new `Coord.cftimes()` + `Coord.calendar`, widened `Label`, new `CFDatetime` export, new runtime dep `cftime-ts@^0.1.1`. Nothing existing breaks — `values`/`dates()`/`decoded`/`isTime` all keep their meaning. The one coupling to watch: `CFDatetime` (from a `0.1.x` lib whose API may shift pre-1.0) is now part of our public type surface; the integration is kept boundaried inside `decode/time.ts` + `indexing.ts` so a future cftime-ts change is a localised fix.

**How to verify against real xarray**

Build (or load, via `load_xr.py`) a Dataset with a `360_day` time axis: `time` = `"days since 2000-01-01"`, `calendar="360_day"`, raw `[0, 30, 60, 90]`, plus a `tas(time)` = `[280, 281, 282, 283]`. Under `360_day` every month is 30 days, so those offsets are 1 Jan/Feb/Mar/Apr 2000. (This is `make360DayStore` in `test/fixtures.ts`.)
- xarray: `xr.open_dataset(..., decode_times=True)` (or `use_cftime=True`) → `ds.time.values` is `array([cftime.Datetime360Day(2000,1,1), …])`, `ds.time.dt.calendar == "360_day"`. Ours: `ds.coords.time.decoded === false`, `.dates()` is `undefined`, `.values` is the raw `[0,30,60,90]`, `.calendar === "360_day"`, and `.cftimes().map(d => d.isoformat())` → `["2000-01-01T00:00:00", …, "2000-04-01T00:00:00"]`.
- Selection by datetime — xarray: `ds.sel(time=cftime.Datetime360Day(2000,3,1)).tas == 282`; string `ds.sel(time="2000-02-01").tas == 281`; nearest `ds.sel(time=cftime.Datetime360Day(2000,3,10), method="nearest").tas == 282`. Ours (identical results): `ds.get("tas").sel({ time: new CFDatetime(2000,3,1,0,0,0,0,{calendar:"360_day"}) }).values() === 282`; `sel({ time: "2000-02-01" }) === 281`; `sel({ time: near }, { method: "nearest" }) === 282`.
- Range slice (endpoints inclusive both sides, our convention): `sel({ time: { start: <2000-02-01>, stop: <2000-03-01> } })` → shape `[2]`, `[281, 282]`. (xarray's `.sel(time=slice("2000-02-01","2000-03-01"))` is likewise inclusive on a `CFTimeIndex`.)
- Standard-calendar regression: a `standard` `"days since 2000-01-01"` axis still gives `.values` in epoch-ms and `.dates()` as JS `Date[]` exactly as before — **and** now additionally exposes `.cftimes()`. Confirm the epoch-ms values are unchanged from pre-PR.
- Divergence to expect vs xarray: our `.values` on a non-standard axis is raw numbers, **not** cftime objects — the decoded objects are on `.cftimes()`, and `.dates()` stays `undefined` (we never fabricate a JS `Date` for a calendar it can't represent). Passing a bare JS `Date` to `.sel` on such an axis throws by design.

If you only read one thing in xarray source, read `decode_cf_datetime` in `xarray/coding/times.py`: the pandas-vs-cftime branch is exactly the split we mirror — the one thing we do differently is *not* letting the cftime branch overwrite `.values`, exposing it as `cftimes()` instead.
