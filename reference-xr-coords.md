## This concerns https://github.com/charles-turner-1/xarray-ts/pull/13 and the final implementation

#### It aims to be as faithful as possible to the real xarray implementation.


**`_copy_listed` (the `ds[[names]]` / pickVars rule)**
- `xarray/core/dataset.py` — method `Dataset._copy_listed(self, names)`. This is where `needed_dims` is computed from the listed variables and coordinates are retained iff `set(var.dims) <= needed_dims`.
- Called from `Dataset.__getitem__` (also in `dataset.py`), which dispatches to `_copy_listed` when the key is an iterable/list rather than a single hashable.

**`drop_vars`**
- `xarray/core/dataset.py` — `Dataset.drop_vars(self, names, *, errors=...)`. Worth reading alongside `_assert_all_in_dataset` (same file), which is where the "unknown name" error handling and the `errors="ignore"` option live.

**How `coordinates` becomes non-visible (the `.attrs` vs `.encoding` split)**
- `xarray/conventions.py` — `decode_cf_variables(...)` and `decode_cf(...)`. This is where CF decoding pulls `coordinates` out and uses it to assign coordinate names.
- `xarray/coding/variables.py` — `pop_to(source, dest, key)`, the small helper that moves a key from `attrs` into `encoding` (used pervasively during decode; `coordinates`, `units`, `calendar`, `_FillValue`, etc. all go through this pattern).
- Specifically for `coordinates`: look in `conventions.py` for `_update_bounds_attributes` / the block that reads `attrs.pop("coordinates")` (sometimes named around `decode_coords`) and folds those names into the coordinate set. The `decode_coords` argument to `open_dataset` gates this behavior.

**Coordinate vs data-variable classification / `needed_dims`-style logic**
- `xarray/core/coordinates.py` and the `Coordinates`/`coord_names` bookkeeping on `Dataset` in `dataset.py`.

If you only read two things, make them `Dataset._copy_listed` in `core/dataset.py` and `pop_to` in `coding/variables.py` — those are the two behaviors we're directly matching (the dims-subset coordinate closure, and moving `coordinates` from attrs into encoding).

One caveat: xarray's internals get reshuffled between releases, so exact function names/locations may differ in whatever version you're looking at — but `_copy_listed`, `conventions.decode_cf_variables`, and `variables.pop_to` have been stable landmarks for a long time.
