# xarray API summary — coordinate management (issue #11 family)

A faithful summary of the **xarray public API** for coordinate management, for reference while
building the xarray-ts equivalents. This is the "what the real API is" companion to
`reference-xr-coord-management.md` (which is "why we implemented it the way we did"). Signatures and
line numbers are from your local `~/xarray` checkout — landmarks, not gospel (releases drift).

Two concepts underpin all of it:

- **Dimension (index) coordinate** — a 1-D coordinate whose name equals its dimension. Backs a
  pandas index; this is what `.sel()` uses. Lives in `Dataset._indexes`.
- **Non-dimension / auxiliary coordinate** — any other coordinate (scalar, N-d like `lat(y, x)`, or
  a 1-D coord not named after its dim). No index; not usable for label lookup.

In xarray, coordinates and data variables share one underlying `_variables` dict; the only
difference is membership in `_coord_names`. That is exactly the xarray-ts model (`#coordNames` /
`#dataVarNames` over a single `#vars`).

---

## `Dataset.set_coords(names)` — `dataset.py:1811` ✅ implemented as `setCoords`

```python
set_coords(names: Hashable | Iterable[Hashable]) -> Dataset
```

- Marks existing variable(s) as coordinates: `_assert_all_in_dataset(names)`, then
  `_coord_names.update(names)`. **No IO, no data movement.**
- Idempotent (checked against `_variables`, not `data_vars`, on purpose).
- Does **not** create new coordinates — the names must already be variables.
- Errors: unknown name → the dataset's standard "variable not found" error.

**xarray-ts:** `setCoords(names)` — synchronous, promotes to a *lazy* auxiliary coordinate.

## `Dataset.reset_coords(names=None, drop=False)` — `dataset.py:1868` ✅ implemented as `resetCoords`

```python
reset_coords(names=None, drop=False) -> Dataset
```

- Demotes non-index coordinates back to data variables.
- `names=None` → all non-index coords: `_coord_names - set(_indexes)`.
- Explicit names: `_assert_all_in_dataset`, then reject index coords —
  `bad = set(names) & set(_indexes)` → `ValueError("cannot remove index coordinates with
  reset_coords: {bad}")` (`dataset.py:1956`).
- `_coord_names.difference_update(names)`; if `drop=True`, also `del _variables[name]`.
- `DataArray.reset_coords` (`dataarray.py:1003`, overloaded) additionally errors if you try to
  reset the array's own name.

**xarray-ts:** `resetCoords(names?, { drop })` — "index coordinate" ≡ our dimension coordinate.

## `assign_coords(coords=None, **coords_kwargs)` — `common.py:520` ⬜ not yet implemented

```python
assign_coords(coords: Mapping | None = None, **coords_kwargs) -> Self   # Dataset & DataArray
```

- Returns a new object with **new or replaced** coordinates added to the existing data. The most
  general of the family — it *creates* coordinates, unlike `set_coords`.
- Value forms accepted per key:
  - a plain value / array / `DataArray` → assigned directly as the coordinate;
  - a `(dim, values)` tuple → a new coord attached to an existing dimension (e.g.
    `assign_coords(lon_2=("lon", arr))`);
  - a callable → called with the object, its return used as the coord (enables
    `assign_coords(lon=lambda o: ((o.lon + 180) % 360) - 180)`);
  - a `Coordinates` object / mapping.
- Assigning a 1-D coord **named after a dimension** creates/refreshes that dimension's index;
  assigning under a new name on an existing dim creates a non-dimension coordinate.
- Immutable: original object is unchanged; only listed coords are added/overwritten.

**xarray-ts fit:** the interesting/hard one. Requires accepting caller-provided values (arrays,
tuples, scalars) rather than only reclassifying existing variables — so it needs a "coordinate from
literal data" path, not just a zarr handle. The `(dim, values)` and scalar forms map cleanly to a
lazy/eager `Coord`; the callable and `DataArray`-value forms are larger. Natural next step after
set/reset, and it pairs with the lazy-coord representation already in place.

## `Dataset.swap_dims(dims_dict, **kwargs)` — `dataset.py:4375` ⬜ not yet implemented

```python
swap_dims(dims_dict: Mapping[Any, Hashable] | None = None, **dims_kwargs) -> Dataset
```

- Swaps a dimension for a coordinate/variable defined along it. `swap_dims({"x": "y"})` makes `y`
  the new dimension (and its index, if `y` is 1-D along `x`), and demotes the old `x` to a
  non-dimension coordinate on the new axis.
- Validation (both must hold):
  - the source key must be an existing dimension → else `ValueError("cannot swap from dimension
    ... not one of the dimensions")`;
  - the target must be a **1-D variable along the old dimension** →
    `variables[new].dims == (current,)`, else `ValueError("replacement dimension ... is not a 1D
    variable along the old dimension")`.
- If the target has no existing variable, you get a "dimension without coordinate" (like
  `rename_dims`); if it does and it's 1-D, it becomes the new **dimension coordinate** with an
  index. New `coord_names` = old ∪ `{new dims that are variables}`.
- The source in the code even notes: *"TODO: deprecate this method in favor of a (less confusing)
  rename_dims()."* — i.e. `swap_dims` ≈ the "also move the index" cousin of our `renameDims`.

**xarray-ts fit:** mostly metadata + reuses an already-materialised 1-D coord as the new index →
can stay **synchronous** in the hybrid model (the target 1-D coord along the old dim would be an
eager dimension-ish coord, or needs one eager load). Relates directly to our `renameDims` divergence
note and to index infra (#12).

---

## Neighbors (index infrastructure — issue #12, for context)

- **`Dataset.set_index(indexes=None, append=False, **kwargs)`** — `dataset.py:4725`. Set a
  (multi-)index from existing 1-D coordinates. Pulls in `stack`/`unstack`-adjacent machinery and a
  real `Index` abstraction — out of scope for the minimal layer today.
- **`Dataset.reset_index(dims_or_levels, drop=False)`** — `dataset.py:4890`. Inverse: turn an index
  back into plain coordinates (or drop). These are the `_indexes`-heavy APIs #12 is really about;
  `set_coords`/`reset_coords`/`swap_dims` sit *above* them and don't need a full index abstraction.

---

## One-line map

| xarray | signature essence | xarray-ts |
| --- | --- | --- |
| `set_coords` | mark existing vars as coords (no IO, idempotent) | ✅ `setCoords` |
| `reset_coords` | demote non-index coords (reject index; `drop`) | ✅ `resetCoords` |
| `assign_coords` | add/replace coords from values/tuples/callables | ⬜ next candidate |
| `swap_dims` | make a 1-D coord the dimension; old dim → aux coord | ⬜ (metadata; syncable) |
| `set_index` / `reset_index` | build/tear down (multi-)indexes | ⬜ #12, needs Index abstraction |

Caveat: xarray moves internals between releases. `set_coords`, `reset_coords`, `assign_coords`,
`swap_dims`, `_coord_names` and `_indexes` have been stable landmarks for a long time; line numbers
will drift.
