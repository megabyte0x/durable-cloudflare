import { PythonSci } from "nanocode-ts/bash";
import python from "nanocode-ts-polars/python.wasm";

interface Env {
  ASSETS: Fetcher;
}

export default {
  fetch: (request, env) => PythonSci.serve(request, { module: python, data: PythonSci.assets(env.ASSETS) }),
} satisfies ExportedHandler<Env>;
