export interface SemanticSymbolFact {
  readonly id: string;
  readonly name: string;
}

export interface SemanticTypeFact {
  readonly id: string;
  readonly texts: readonly string[];
}

export interface SemanticPositionFact {
  readonly symbol: SemanticSymbolFact | null;
  readonly type: SemanticTypeFact | null;
}

/** Minimal compiler-neutral checker boundary used during the Corsa migration. */
export interface SemanticQueryFrontend {
  readonly compilerRevision: string;
  readonly rootFiles: readonly string[];
  queryPosition(file: string, position: number): SemanticPositionFact;
  close(): void;
}
