import xarray as xr
ds = xr.open_zarr("https://projects.pawsey.org.au/dwer-zarr-store-rechunked/data.zarr")
print(ds.variables)
