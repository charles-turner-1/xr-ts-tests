## This concerns https://github.com/charles-turner-1/xarray-ts/pull/22 — `swapDims()`

Second op from issue #11 (after `set_coords`/`reset_coords` in #15). Companion to the rename / squeeze / coords notes. Line numbers are landmarks from a local `~/xarray` checkout, not gospel (see the caveat at the end).

**Where xarray implements it**
- `xarray/core/dataset.py` — `Dataset.swap_dims(dims_dict=None, **dims_kwargs)`. (`DataArray.swap_dims` is a thin wrapper that swaps on the array's single variable + its coords — we don't implement that yet; see the scope note.)
- Validation, per swapped pair `current_name -> new_name`:
  - `current_name` must be a dimension: `if current_name not in self.dims: raise ValueError("cannot swap from dimension {current_name!r} because it is not one of the dimensions of this dataset")`. Ours: `cannot swap from dimension "<x>" — it is not a dimension of this Dataset.`
  - if `new_name` names an existing variable, it must be 1-D along `current_name`: `if new_name in self.variables and self.variables[new_name].dims != (current_name,): raise ValueError("replacement dimension {new_name!r} is not a 1D variable along the old dimension {current_name!r}")`. Ours mirrors this message closely (`is not a 1-D variable along "<x>"`).
  - (We add one guard xarray reaches differently: swapping onto a name that is *already another dimension* → `cannot swap dimension "x" to existing dimension "y"`, symmetric with our `renameDims` guard.)
- The transform (paraphrased): `coord_names.update({dim for dim in dims_dict.values() if dim in self.variables})` — **the swapped-in variable is promoted to a coordinate** — then every variable's dims are relabelled through `dims_dict`, and for the new dimension coordinate xarray builds a `PandasIndex` (which materialises its values).

**How ours maps onto that (`src/dataset.ts` `swapDims`)**
- Same two validation branches, plus the existing-dimension guard.
- `renameVariable(variable, name, dims)` (module-local, already used by `rename`) relabels each variable's dims while keeping its **name** — so `lon` keeps its name and goes dims `["x"] -> ["lon"]`; the old `x` coordinate keeps its name and also goes `["x"] -> ["lon"]`.
- Promotion is exactly the reclassification `setCoords` does: add `new_name` to `coordNames`, drop it from `dataVarNames`. The old dimension coordinate stays in `coordNames` — it is simply no longer a *dimension* coordinate (`isDimensionCoord` now returns false for it: name `x` ≠ dim `lon`).
- The eager old dim coord is relabelled via `renameCoord` and **stays eager** in `#rootCoords` (values already loaded at open). The `coords` getter renders it through `sliceCoord(eager, axisFor("lon"))` → a non-dimension coordinate `x` with dims `["lon"]`, values intact.
- `#dimSizes` is recomputed from the new `vars` by the constructor (drops `x`, adds `lon`); `#axesByDim` keys are relabelled, so a prior `isel`/`sel` selection carries over (`ds.isel({x:1}).swapDims({x:"lon"})` keeps the selection under `lon`). No IO, no new axis kinds.

**The one deliberate divergence — the new dim coord is lazy**
- xarray builds a pandas Index for the new dimension coordinate during `swap_dims`, which *materialises* `lon`'s values. We do **not**: `lon` wasn't a dimension coordinate at open, so it isn't in `#rootCoords`, so the `coords` getter surfaces it via `makeLazyCoord` (dims `["lon"]`, `isDimensionCoord` true, values on `await`).
- Consequence we accept and document: label-based `.sel({lon: ...})` throws our standard `requires an eager dimension coordinate` error (the lazy-coord guard in `sel`). This is the *same* limitation `setCoords` already calls out when you promote a dimension-shaped variable. Rationale: every other metadata op here is synchronous and chainable; making `swapDims` async purely to eagerly index would be the surprising choice. Loading eagerly is a future additive option, not a semantic change.

**Scope: Dataset only (DataArray deferred)**
- `DataArray` currently threads only *eager dimension coordinates* into its `#coords` (auxiliary / N-d coords aren't wired in — that's issue #7). A faithful `DataArray.swap_dims` target coordinate would essentially never be visible, so it's deferred until #7 rather than shipped half-working. This is the one place `swapDims` differs from `squeeze`, where both `Dataset` and `DataArray` made sense.

**How to verify against real xarray**
Build a Dataset with dims `x`, `y`, a dim coord `x=[0,1,2]`, and a **data variable** `lon(x)=[100,110,120]` (no `coordinates` attr, so it starts as a data var), plus `temp(y, x)`.
- `ds.swap_dims({"x": "lon"})` → `"x" not in ds.dims`, `"lon" in ds.dims`; `ds["lon"]` is now the dimension coordinate; `ds["x"]` is a **non-dimension** coordinate with dims `("lon",)`; `ds["temp"].dims == ("y", "lon")`; `"lon"` moved from data_vars to coords. Ours: `swapped.dims == {lon:3, y:2}`, `swapped.get("temp").dims == ["y","lon"]`, `Object.keys(swapped.data_vars) == ["temp"]`, `coords.x.dims == ["lon"]` (eager, values `[0,1,2]`), `coords.lon` lazy with `await .values() == [100,110,120]`.
- `ds.swap_dims({"z": "lon"})` → `ValueError: cannot swap from dimension 'z' ...`. Ours: `/not a dimension/`.
- `ds.swap_dims({"x": "temp"})` (temp is 2-D) → `ValueError: replacement dimension 'temp' is not a 1D variable along the old dimension 'x'`. Ours: `/not a 1-D variable along "x"/`.
- Selection carry-over: `ds.isel(x=slice(1,3)).swap_dims({"x":"lon"}).sizes` → `lon: 2`. Ours: `ds.isel({x:{start:1,stop:3}}).swapDims({x:"lon"}).dims` → `{lon:2, y:2}` (values line up).
- Divergence to expect: in xarray `ds.swap_dims({"x":"lon"}).sel(lon=110)` works (eager index); in ours it throws `requires an eager dimension coordinate` — by design.
- Metadata-only: trivially lazy for the data var in Python; ours asserts zero chunk reads via a store `get` spy (the eager `x` was read at open, `lon` stays lazy until `.values()`).

If you only read one thing in xarray source, read `Dataset.swap_dims` in `core/dataset.py` — the two validation branches, the `coord_names.update(...)` promotion, and the dim relabel are the three things we mirror; the pandas-Index materialisation is the one thing we deliberately don't.

Caveat, same as the other reference notes: xarray reshuffles internals between releases, so exact names/line numbers drift. `Dataset.swap_dims` in `core/dataset.py` has been a stable landmark for a long time.
