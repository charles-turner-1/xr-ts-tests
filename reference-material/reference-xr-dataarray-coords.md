## This concerns https://github.com/charles-turner-1/xarray-ts/pull/24 — auxiliary coordinates on `DataArray`

Plumbing carved out of issue #7 (and the enabler for a future `DataArray.swap_dims`, #11). Companion to the rename / squeeze / swap-dims / coords notes. Line numbers are landmarks from a local `~/xarray` checkout, not gospel (see the caveat at the end).

**What the gap was**
- Our `Dataset.#dataArray(name)` used to hand each `DataArray` only `#rootCoords` — the *eager dimension coordinates*. Auxiliary coordinates (a 1-D `lon(x)`, a scalar `height`, a 2-D `lat(y, x)`) are lazy and were never passed down, so `DataArray.coords` filtered against a map that structurally excluded them. Dimension coordinates were the only thing it could ever show.

**Where xarray does the equivalent**
- `xarray/core/dataarray.py` — a `DataArray` carries a `DataArrayCoordinates`; the coords it exposes are the parent's coordinate variables **restricted to those whose dims are a subset of the array's dims**. The relevant rule lives in the coordinate-construction path (`core/coordinates.py` / `merge`): a coordinate `c` is attached to a variable when `set(c.dims) <= set(var.dims)`. That subset test is exactly what we mirror.
- xarray makes no eager/lazy distinction here — every coordinate is just a `Variable` (possibly dask-backed). We *do* keep the distinction (dimension coords are eager and drive synchronous `.sel`; everything else is a `LazyCoord`), so our port has to decide eager-vs-lazy per coordinate. See below.

**How ours maps onto that (`src/dataset.ts`, `src/dataarray.ts`)**
- `Dataset.#allCoords()` builds the full, **unsliced** coordinate collection: eager `Coord` for dimension coordinates (straight out of `#rootCoords`), `makeLazyCoord(this.#vars.get(name))` for auxiliary / scalar / N-d coordinates. This is the same eager-vs-lazy split the `Dataset.coords` getter already applies — so nothing new is read; `#dataArray()` just stops throwing information away.
- `DataArray.coords` now keeps every coordinate whose dims are a subset of `variable.dims` (`coord.dims.every(d => variable.dims.includes(d))`) — the identical subset rule already used by `Dataset.pickVars` (`src/dataset.ts:186`). Then:
  - **eager, 1-D** (a dimension coordinate): `sliceCoord(coord, axisFor(dim))` — sliced to the current positional selection. An integer-indexed dim still collapses its coordinate to a scalar (`dims: []`) via the `int`-axis branch of `sliceCoord` — this is what keeps the `squeeze` DataArray behaviour intact.
  - **lazy** (aux / scalar / N-d): returned **unsliced**. Propagating a partial selection through a multidimensional coordinate is the hard part of #7 and is deliberately *not* done here — matching how `Dataset.coords` also hands back lazy aux coords unsliced.
  - Return type widened `Record<string, Coord>` → `Record<string, AnyCoord>`.

**Two knock-on correctness fixes the new visibility forced**
- **`DataArray.sel` lazy guard.** `sel` resolves labels through `this.coords` and calls `lookupLabel` / `lookupLabelSlice`, which require an eager `Coord` (they read `coord.values`, `src/indexing.ts:94,125`). Now that `this.coords` can contain `LazyCoord`s, `sel` throws the same "label selection requires an eager dimension coordinate … use `isel` instead" error that `Dataset.sel` already uses (`src/dataset.ts:274`). A genuine dimension's coordinate is still eager, so ordinary `.sel` is unaffected; the guard only fires if you try to `.sel` by an auxiliary coordinate.
- **`DataArray.rename` lazy handling.** `rename` rebuilds its coord map with `renameCoord`, which assumes an eager `Coord`. With aux coords present it now dispatches on `isLazyCoord` to a new `renameLazyCoord` (`src/coords.ts`): relabel `name`/`dims`, keep the same `load()`, and relabel the *materialised* `Coord` via `renameCoord` so a time aux coord keeps working after a rename. `isel`/`squeeze` pass `#coords` straight through, so lazy entries need no other reconstruction.

**How to verify against real xarray**
- Scalar/1-D aux coord — build a Dataset with `time` (dim coord) and a scalar `height` referenced by `tasmax(time)` via `coordinates: "height"`:
  - xarray: `ds["tasmax"].coords` → `{"time", "height"}`; `ds["tasmax"]["height"].ndim == 0`. Ours: `ds.get("tasmax").coords` keys `["height","time"]`; `height` is lazy (`isLazyCoord` true) with dims `[]` and `await .values() == [2]`; `time` is eager.
- N-d aux coord — `lat(y,x)`, `lon(y,x)` referenced by `temp(y,x)`, plus `pr(y,x)` that names neither:
  - xarray: both `ds["temp"].coords` and `ds["pr"].coords` include `lat`/`lon` (their dims are a subset of `(y, x)`). Ours: same, and `lat` is lazy with dims `["y","x"]`, `await .values() == [0,1,2,3]`.
- Dim-coord slicing still works: `ds["temperature"].isel(x=0)["x"]` is a scalar in xarray; ours: `ds.get("temperature").isel({x:0}).coords["x"].dims == []`, `.values == [100]`.
- Rename an aux coord: xarray `da.rename({"lat": "latitude"})` and `da.rename({"y": "yy"})` relabel the coord and its dims; ours mirrors (`latitude` still lazy, `lat.dims == ["yy","x"]` after the dim rename).
- Divergence to expect: label `.sel` by an auxiliary coordinate. xarray can do some of this (non-index coord selection is limited there too, but N-d/aux is generally not a plain `.sel`); ours flatly throws `requires an eager dimension coordinate` — the same restriction as at the Dataset level. And N-d coords come back **unsliced** after a partial `isel` — that propagation is #7, not this PR.
- Metadata-only: ours asserts zero chunk reads when building `DataArray.coords` and reading keys/`.dims` (lazy coords stay unloaded; eager dim coords were read at open).

If you only read one thing in xarray source, read the coordinate-attachment subset rule (`set(coord.dims) <= set(var.dims)`) in `core/coordinates.py` / the merge path — that single test is what `DataArray.coords` (and our `pickVars`) mirror. The eager-vs-lazy split and the unsliced-N-d deferral are ours, not xarray's.

Caveat, same as the other reference notes: xarray reshuffles internals between releases, so exact names/line numbers drift. The coordinate subset rule and `DataArray.coords` semantics have been stable for a long time.
