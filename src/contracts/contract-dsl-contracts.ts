import type { NumericDomain } from "./logic-contracts.js";

export interface ParsedContractDsl {
  parameters: Array<{ name: string; domain: NumericDomain }>;
  resultDomain: NumericDomain;
  requires: string[];
  ensures: string[];
}
export interface ContractClauseProvenance {
  kind: "requires" | "ensures";
  expression: string;
  fileName: string;
  line: number;
  column: number;
  span: { start: number; end: number };
}
export interface PreparedContractDslLinks {
  files: Record<string, string>;
  provenance: Record<string, ContractClauseProvenance[]>;
}

