## This concerns the lazy-coordinate refactor + `setCoords` / `resetCoords` work (issue #11, groundwork from #5)

#### It aims to be as faithful as possible to the real xarray implementation, diverging only where our read-only, eager-`.sel()` model forces it.

This is the companion to `reference-xr-coords.md` (coords classification + drop/pick) and
`reference-xr-rename.md`. Line numbers are from your local `~/xarray` checkout — landmarks, not
gospel (caveat at the end).

---

### Why this turned into a coordinate-model change first

The obvious next brick was `set_coords` / `reset_coords`. But xarray-ts materialised **every**
coordinate eagerly at open (`group.ts:datasetFromGroup` called `loadCoord` for all coord names),
and `Coord.values` / `.sel()` are synchronous. Under that model, promoting a data variable to a
coordinate (`setCoords`) would have to **read the array** to materialise it, forcing an `async`
`Promise<Dataset>` return — a divergence from xarray, where `set_coords` does no IO.

So we fixed the root cause: **hybrid lazy coordinates.**

- **Dimension coordinates** (1-D, `dims == [name]`) stay eager. They are small and drive label
  lookup, so `.sel()` and `coord.values` remain synchronous — the ergonomics the README sells.
- **Auxiliary / scalar / N-d coordinates** (e.g. curvilinear 2-D `lat(y, x)` / `lon(y, x)`) become
  **lazy**: not read at open, materialised on demand via `await ds.coords.lat.load()`. This is also
  the direct win asked for in issue #5 (don't eagerly pull big 2-D grids just to open a dataset).

The deliberate rejection was "make coordinates *totally* lazy." That would have made `.sel()` and
`coord.values()` async everywhere — breaking the advertised synchronous surface — for no benefit on
the common 1-D dimension-coordinate path. Issue #5 itself floats the hybrid ("Should 1-D dimension
coordinates stay eager by default while only auxiliary / N-D coords become lazy?"); we took it.

With aux coords lazy, `setCoords` collapses to a **synchronous, zero-IO, metadata-only**
reclassification — a promoted variable is just a lazy aux coord, nothing to load. That is exactly
xarray's semantics, so the divergence disappears.

### Representation (xarray-ts internals)

`Dataset` already keeps the lazy `Variable` (zarr handle) for **every** variable — coordinates
included — in `#vars`. So the change is small:

- `#rootCoords` now holds **only eagerly-loaded dimension coordinates**.
- `#coordNames` still holds **all** coordinate names (dim + aux).
- The `coords` getter iterates `#coordNames`: eager `Coord` (sliced) when present in `#rootCoords`,
  else a `LazyCoord` built on demand from `#vars` (`src/coords.ts:makeLazyCoord`, which memoises
  `loadCoord`). No new storage for lazy coords — they are reconstructed from the retained handle.
- `isDimensionCoord(v)` = `v.dims.length === 1 && v.dims[0] === v.name` — the eager/lazy split and
  the "index coordinate" test both use this.
- `isLazyCoord(coord)` is the public type guard for the `Coord | LazyCoord` (`AnyCoord`) union. It
  exists because a heterogeneous `.coords` map can't be statically narrowed; `.dates()`/`.decoded`
  live only on the eager `Coord`.

---

### `set_coords` / `reset_coords` — the xarray landmarks (`~/xarray/xarray/core/dataset.py`)

**`Dataset.set_coords(names)` (~L1811)**
- `_assert_all_in_dataset(names)`, then `obj._coord_names.update(names)`. That's it — no IO.
- Idempotent *by design*: the comment says "check in self._variables, not self.data_vars to insure
  that the operation is idempotent." Promoting an existing coordinate is a no-op.
- **Our `setCoords`** mirrors this exactly: validate all names in `#vars` (reusing `#validatedNames`),
  add to `coordNames`, remove from `dataVarNames`. The promoted coord is lazy (aux), so nothing is
  read. Accepts a single string or an iterable, like xarray's `Hashable | Iterable[Hashable]`.
- One documented limitation: `setCoords` never materialises. If you promote a dimension-shaped
  variable and then need it *loaded* for `.sel()`, that's the eager-open path — revisit under #5's
  explicit-materialisation API. (xarray doesn't hit this because its coords are lazy anyway.)

**`Dataset.reset_coords(names=None, drop=False)` (~L1868)**
- `names=None` → all **non-index** coordinates: `self._coord_names - set(self._indexes)`.
- else: `_assert_all_in_dataset(names)`, then the hard guard (~L1956):
  `bad_coords = set(names) & set(self._indexes)` → `raise ValueError("cannot remove index
  coordinates with reset_coords: {bad_coords}")`.
- `obj._coord_names.difference_update(names)`; if `drop`, `del obj._variables[name]`.
- **Our `resetCoords`** mirrors this: no-arg resets all coords that are **not** dimension
  coordinates; explicit names are validated and rejected if they are dimension coordinates with
  `xarray-ts: cannot reset index (dimension) coordinates: [...]`. Non-drop moves the names into
  `dataVarNames`; `{ drop: true }` deletes the variables from `#vars` entirely.
- **"Index coordinate" ≡ our dimension coordinate.** xarray's `self._indexes` are the coordinates
  backing a pandas index — in this minimal layer that is precisely the 1-D dimension coordinates
  (`isDimensionCoord`). We don't have multi-indexes, so the mapping is exact.

Both go through a shared `#reclassified(coordNames, dataVarNames, vars?)` helper that rebuilds the
Dataset preserving the current selection, keeps only surviving eager dim coords in `#rootCoords`,
and filters `#axesByDim` to dims still spanned by a variable (same pattern as `#subset` from the
drop/pick work — so a `drop: true` that removes the last variable on a dim also drops the dim).

### Knock-on: `.sel()` guard

`Dataset.sel` resolves labels through `this.coords`. Now that an entry can be a `LazyCoord`, we
guard: selecting by a key that resolves to a lazy (auxiliary) coordinate throws
`label selection requires an eager dimension coordinate ... use isel instead`. This was never
supported (you can only `.sel` by a dimension in this library), it's just now an explicit error
rather than a crash on a missing `.values`.

### What did NOT change (and why the regression surface was tiny)

No existing test read `.values` on an auxiliary or scalar coordinate — every aux/scalar assertion
checked `Object.keys(ds.coords)` (presence), and the only `.values` reads were on dimension
coordinates (`x`), which stay eager. The one scalar-coord test (`height`) moved from asserting an
eager `.values` array to `await coord.values()`, since scalar coords are now lazy. `DataArray.coords`
still surfaces only 1-D dimension coordinates — surfacing lazy N-d aux coords there is issue #7,
intentionally left as a follow-up.

---

If you only read two things: `Dataset.set_coords` (~L1811, the `_coord_names.update` no-op-IO
promotion we mirror) and `Dataset.reset_coords` (~L1868 + the index-coordinate guard at ~L1956, the
demotion + "cannot remove index coordinates" rule). The hybrid-lazy decision is ours, forced by the
eager-`.sel()` model; everything else tracks xarray.

Caveat, same as the other docs: xarray reshuffles internals between releases, so exact names/line
numbers drift. `set_coords`, `reset_coords`, `_assert_all_in_dataset` and `_indexes` have been
stable landmarks for a long time.
