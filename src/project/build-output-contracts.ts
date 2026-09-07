export interface BuildOutputFileIntegrity {
  kind: "declaration" | "runtime";
  status: "verified" | "missing" | "mismatch";
  fileName: string;
  projectFile?: string;
  expectedDigest: string;
  actualDigest?: string;
  message?: string;
}

export interface BuildOutputIntegrity {
  status: "not-checked" | "verified" | "missing" | "mismatch" | "error";
  outputs: BuildOutputFileIntegrity[];
  message?: string;
}

