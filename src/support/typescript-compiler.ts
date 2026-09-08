/** Legacy Compiler API compatibility boundary. */
import { createRequire } from "node:module";
import ts from "@typescript/typescript6";

const require = createRequire(import.meta.url);
export default ts;
export const compilerPackageFile = require.resolve("@typescript/typescript6/package.json");
