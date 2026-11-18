import { copyFile, mkdir, rm, stat } from "node:fs/promises";

const from = "node_modules/nanocode-ts-polars/assets";
await rm("output/python-sci", { force: true, recursive: true });
await mkdir("output/python-sci", { recursive: true });
for (const name of ["python.data.0", "python.data.1"]) {
  const { size } = await stat(from + "/" + name);
  if (size > 25 * 1024 * 1024) throw new Error(from + "/" + name + " is " + size + " bytes, over the 25 MiB a static asset may hold");
  await copyFile(from + "/" + name, "output/python-sci/" + name);
}
