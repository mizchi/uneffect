use uneffect_core::corsa::{CallbackTiming, CorsaSymbolKind, NativeEvidence, consume_corsa_json};

#[test]
fn consumes_versioned_corsa_symbols_types_overloads_calls_and_trivia() {
    let program = consume_corsa_json(r#"{
      "schemaVersion": 1,
      "fileId": 7,
      "compilerRevision": "typescript-go@deadbeef",
      "symbols": [
        { "id": 1, "name": "load", "kind": "function", "typeRepr": "(p: string) => string", "overloads": ["(p: string): string"], "effectParameters": [], "span": { "start": 10, "end": 80 } },
        { "id": 2, "name": "callback", "kind": "callback", "typeRepr": "() => void", "overloads": [], "effectParameters": [0], "span": { "start": 90, "end": 110 } }
      ],
      "calls": [{ "caller": 1, "callee": 2, "overloadIndex": null, "callbackTiming": "inline", "span": { "start": 60, "end": 70 } }],
      "trivia": [{ "owner": 1, "text": "/* uneffect: effect FsRead<\"$CWD/data\"> */", "span": { "start": 0, "end": 45 } }]
    }"#).unwrap();
    assert_eq!(program.compiler_revision, "typescript-go@deadbeef");
    let load = &program.symbols[&1];
    assert_eq!(load.kind, CorsaSymbolKind::Function);
    assert_eq!(load.overloads.len(), 1);
    assert_eq!(load.evidence, NativeEvidence::Trusted);
    assert_eq!(program.calls[0].callback_timing, CallbackTiming::Inline);
}

#[test]
fn rejects_unknown_schema_and_dangling_symbol_edges() {
    let unsupported = r#"{"schemaVersion":2,"fileId":1,"compilerRevision":"x","symbols":[],"calls":[],"trivia":[]}"#;
    assert!(
        consume_corsa_json(unsupported)
            .unwrap_err()
            .to_string()
            .contains("unsupported")
    );
    let dangling = r#"{"schemaVersion":1,"fileId":1,"compilerRevision":"x","symbols":[],"calls":[{"caller":1,"callee":2,"overloadIndex":null,"callbackTiming":"unknown","span":{"start":0,"end":1}}],"trivia":[]}"#;
    assert!(consume_corsa_json(dangling).is_err());
}
