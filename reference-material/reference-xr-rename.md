Sure. This one is the companion to `reference-xr-coords.md`, for the rename PR (`renameVars` / `renameDims` / `DataArray.rename`). Line numbers are from your local `~/xarray` checkout, so treat them as landmarks, not gospel (see the caveat at the end).

**The core rename machinery**
- `xarray/core/dataset.py` — `Dataset._rename_vars(self, name_dict, dims_dict)` (~L4155). This is the loop we mirror: for each variable it shallow-copies, remaps `var.dims` via `dims_dict.get(dim, dim)`, renames the variable via `name_dict.get(k, k)`, and rebuilds `coord_names` with `if k in self._coord_names: coord_names.add(name)`. Our `#renamed` does exactly this (rename vars + carry classification forward through `coordNames`).
- `Dataset._rename_dims` (~L4171) — trivially remaps the sizes dict: `{name_dict.get(k, k): v ...}`. It does **not** touch variables.
- `Dataset._rename_all` (~L4197) — the orchestrator that calls the two above plus `_rename_indexes`.

**Where the public APIs split (and why ours look the way they do)**
- `Dataset.rename_vars` (~L4335) → `_rename_all(name_dict=..., dims_dict={})`. Renames variables/coordinates only, never dimensions. **Our `renameVars` is a faithful mirror of this.**
- `Dataset.rename_dims` (~L4288) → `_rename_all(name_dict={}, dims_dict=...)`. Renames **only the dimension**. If a dimension coordinate `x` existed, after `rename_dims({x: "lon"})` you get a variable still named `x` sitting on dimension `lon` — i.e. a *non-dimension* coordinate. It also hard-rejects a target that collides with an existing dim or variable (`if v in self.dims or v in self: raise ... "Try using swap_dims instead."`).
- **This is our one deliberate divergence.** Our `renameDims` *also* renames the matching dimension-coordinate variable (`x → lon`) so it stays a dimension coordinate (name == dim) and `.sel()` / `ds.coords` keep working. In real xarray that combined move is `rename()` (or `swap_dims`), not `rename_dims`. We fold the common intent into `renameDims` because a read-only viewer/codegen layer shouldn't silently demote a dimension coordinate into a dangling aux coord — that's a footgun with no upside here. See the docstring on `renameDims` in `src/dataset.ts`.
- `Dataset.rename` / `Dataset._rename` (~L4213) — the combined API (renames vars *and* dims). Worth reading for the `create_dim_coord` block (~L4229): modern xarray *warns* that renaming a dim↔coord "does not create an index anymore." That warning is the flip side of what we chose — we keep the dim coordinate aligned on purpose, precisely so the index-like `.sel()` path stays intact.

**Duplicate-target rejection**
- The guard we added lives verbatim in xarray: `_rename_vars` raises `ValueError(f"the new name {name!r} conflicts")` when two source names collapse onto one target (dataset.py ~L4164). We surface it as an explicit up-front check for both vars and dims (`cannot rename multiple variables/dimensions to "…"`) rather than discovering it mid-build.

**The bug we fixed, in xarray terms**
- xarray's `rename_dims` renames a dimension whether or not a coordinate of that name exists (it only remaps `sizes`). Our original `renameDims` routed *every* dimension through the variable-rename path, so a dimension with no coordinate variable threw "no variable named …". The fix restricts the variable-rename map to dims that actually have a coordinate (`#coordNames.has(oldDim)`), matching xarray's "dims are independent of whether a coord exists" behavior.

**Why there's no `coordinates`-attr rewriting**
- Because `coordinates` lives in `encoding`, not `attrs` (see `reference-xr-coords.md` → `pop_to` / `decode_cf_variables`), and classification is carried in `coord_names`. xarray doesn't rewrite a user-visible `coordinates` attribute on rename either — `_rename_vars` just rebuilds `coord_names`. So the PR's original `renameCoordReferences` helper was dropped as dead weight; rename now carries `attrs`/`encoding` through untouched.

**DataArray.rename**
- `xarray/core/dataarray.py` — `DataArray.rename` (~L2565). A string renames the array's `.name`; a mapping renames its coords/dims. We implement only the string form (`da.rename("tas")`) — a lazy view with the same data/coords and a new name.

If you only read two things, read `Dataset._rename_vars` (the rename+coord_names+dedupe loop we mirror) and `Dataset.rename_dims` (the dim-only behavior we intentionally *don't* mirror, choosing to also rename the dim coordinate).

Caveat, same as before: xarray reshuffles internals between releases, so exact names/line numbers drift. `_rename_vars`, `_rename_all`, `rename_dims`, and `rename_vars` have been stable landmarks for a long time.
