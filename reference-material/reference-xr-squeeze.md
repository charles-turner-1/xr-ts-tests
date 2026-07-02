## This concerns https://github.com/charles-turner-1/xarray-ts/pull/21 — `squeeze()`

First structural op from issue #10. Companion to the rename / coords notes. Line numbers are landmarks from a local `~/xarray` checkout, not gospel (see the caveat at the end).

**Where xarray implements it**
- `xarray/core/common.py` — `get_squeeze_dims(xarray_obj, dim, axis=None)` and the `squeeze(...)` mixin method that both `Dataset` and `DataArray` inherit (`DataWithCoords.squeeze`). This is the shared implementation we mirror.
- `get_squeeze_dims` resolves the target dims: when `dim is None` it selects **every** dimension whose size is 1 (`[d for d, s in sizes.items() if s == 1]`); when `dim` is given it validates each named dim actually has size 1 and raises otherwise: `ValueError("cannot select a dimension to squeeze out which has length greater than one")`. We mirror both branches (our message is phrased `cannot squeeze dimension "<d>" of size <n> (must be 1)`).
- `squeeze` then calls `self.isel(drop=drop, **{d: 0 for d in dims})`. **That last line is the whole trick** — squeeze *is* `isel` with an integer index of 0 on each size-1 dim. Our implementation makes the same reduction explicit.

**How ours maps onto that (`src/dataset.ts`, `src/dataarray.ts`)**
- Both `Dataset.squeeze(dim?)` and `DataArray.squeeze(dim?)` compute the target dims from the **current** view sizes (`this.dims` on the Dataset; `this.dims`/`this.shape` on the DataArray — both already skip axes that were previously integer-indexed away), run the same length-1 guard, then `return this.isel(Object.fromEntries(targets.map(d => [d, 0])))`.
- Because it funnels into `isel`, there is *no new machinery*. In our axis model (`src/axis.ts`) an integer indexer becomes an `int` axis via `composeInt`; the `dims`/`shape` getters skip `int` axes (so the dimension disappears), and `sliceCoord`'s `int` branch (`src/axis.ts:64`) returns `{ dims: [], values: [one] }` — i.e. the dropped **dimension coordinate becomes a scalar coordinate**, exactly xarray's behavior. Data variables shrink through the normal lazy `DataArray` view; nothing is read until `load()`.
- **Composition is free.** Sizes come from the current view, so `ds.isel({ time: 0 }).squeeze()` squeezes what's left. This matches xarray, where `squeeze` operates on `obj.sizes` after any prior selection.

**Two deliberate scope cuts (documented in the docstrings)**
- **`drop=True` not implemented.** xarray's `squeeze(drop=True)` *removes* the squeezed coordinate entirely instead of keeping it as a scalar. We always keep it as a scalar coordinate (the `drop=False` default). Rationale: a read-only metadata viewer shouldn't silently discard coordinate identity; adding `drop` later is a pure additive branch (delete from `coordNames`/`vars`, like `resetCoords({ drop: true })` already does).
- **Positional `axis=` not implemented.** xarray also accepts integer axis positions; we only take dimension names, consistent with the rest of xarray-ts's name-first surface (`isel`/`sel` are keyed by dim name).

**How to verify against real xarray**
Build a Dataset with a size-1 dimension that has a dimension coordinate (`level=[1000]`), a normal dim (`time`), and a data var on both, then compare:
- `ds.squeeze()` → `level` is gone from `ds.dims`; `ds["level"]` is now a **scalar** coordinate (`ds["level"].ndim == 0`); `ds["temperature"].dims == ("time", "y")`. In ours: `squeezed.dims`, `squeezed.coords["level"].dims == []` with `.values == [1000]`, and `squeezed.get("temperature").dims`.
- `ds.squeeze("level")` → identical to the no-arg form here (only one size-1 dim).
- `ds.squeeze("time")` → `ValueError: cannot select a dimension to squeeze out which has length greater than one`. Ours throws `cannot squeeze dimension "time" of size 3`.
- `ds.isel(time=0).squeeze()` → both `time` and `level` gone; proves squeeze reads post-selection sizes.
- `da = ds["temperature"]; da.squeeze()` → same dim drop on the array; `.values` still loads the right shape. Ours asserts `.isel({time:0}).values()` is a `Float32Array` of length 2.
- Metadata-only: trivially lazy in Python; ours guarantees "no chunk reads", asserted with a store `get` spy.

If you only read one thing in xarray source, read `common.py` `squeeze` / `get_squeeze_dims` — the size-1 selection, the length->1 error, and the `isel(**{d: 0})` delegation are the three things we mirror.

Caveat, same as the other reference notes: xarray reshuffles internals between releases, so exact names/line numbers drift. `squeeze` / `get_squeeze_dims` in `core/common.py` have been stable landmarks for a long time.
