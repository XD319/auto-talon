import { rmSync } from "node:fs";
import { resolve } from "node:path";

rmSync(resolve("dist"), { force: true, recursive: true });
