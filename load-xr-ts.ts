import { openDataset, openZarr, fromHttp } from "xarray-ts";
const ds = await openDataset(fromHttp("https://projects.pawsey.org.au/dwer-zarr-store-rechunked/data.zarr"));

console.log(ds.variables);
