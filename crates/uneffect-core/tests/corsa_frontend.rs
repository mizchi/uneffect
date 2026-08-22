use uneffect_core::corsa::{CallbackTiming, CorsaSymbolKind, NativeEvidence, consume_corsa_json};

#[test]
fn consumes_versioned_corsa_symbols_types_overloads_calls_and_trivia() {
    let program = consume_corsa_json(r#"{
      "schemaVersion": 6,
      "fileId": 7,
      "compilerRevision": "typescript-go@deadbeef",
      "symbols": [
        { "id": 1, "name": "load", "kind": "function", "typeRepr": "(p: string) => string", "overloads": ["(p: string): string"], "effectParameters": [], "span": { "start": 10, "end": 80 } },
        { "id": 2, "name": "callback", "kind": "callback", "typeRepr": "() => void", "overloads": [], "effectParameters": [0], "span": { "start": 90, "end": 110 } }
      ],
      "calls": [{ "caller": 1, "callee": 2, "overloadIndex": null, "callbackTiming": "inline", "span": { "start": 60, "end": 70 } }],
      "protocolSymbols": [],
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
    let unsupported = r#"{"schemaVersion":7,"fileId":1,"compilerRevision":"x","symbols":[],"calls":[],"trivia":[],"protocolSymbols":[]}"#;
    assert!(
        consume_corsa_json(unsupported)
            .unwrap_err()
            .to_string()
            .contains("unsupported")
    );
    let dangling = r#"{"schemaVersion":6,"fileId":1,"compilerRevision":"x","symbols":[],"calls":[{"caller":1,"callee":2,"overloadIndex":null,"callbackTiming":"unknown","span":{"start":0,"end":1}}],"trivia":[],"protocolSymbols":[]}"#;
    assert!(consume_corsa_json(dangling).is_err());
}

#[test]
fn validates_resource_disposal_protocol_symbol_identity() {
    let input = |protocol_symbol: u64, protocol_kind: &str| {
        format!(
            r#"{{
      "schemaVersion":6,"fileId":1,"compilerRevision":"x",
      "symbols":[{{"id":1,"name":"run","kind":"function","typeRepr":"() => void","overloads":[],"effectParameters":[],"span":{{"start":0,"end":1}}}}],
      "calls":[],"trivia":[],
      "protocolSymbols":[{{"id":7,"kind":"sync","fileName":"resource.ts","span":{{"start":2,"end":3}}}}],
      "resourceScopes":[{{"owner":1,"binding":"resource","ownerAsync":false,"asynchronous":false,"conditional":false,"controlConditions":[],"controlPaths":[[]],"acquisitionIndex":0,"scopeId":"scope","scopeDepth":0,"scopeEnd":10,"catchesFailure":false,"disposalFailureType":"Error","protocolSymbol":{protocol_symbol},"protocolKind":"{protocol_kind}","span":{{"start":4,"end":5}}}}]
    }}"#
        )
    };
    assert!(consume_corsa_json(&input(7, "sync")).is_ok());
    assert!(
        consume_corsa_json(&input(8, "sync"))
            .unwrap_err()
            .to_string()
            .contains("unknown disposal protocol")
    );
    assert!(
        consume_corsa_json(&input(7, "async"))
            .unwrap_err()
            .to_string()
            .contains("does not match")
    );
}

#[test]
fn rejects_invalid_or_contradictory_control_conditions() {
    let input = |conditions: &str| {
        format!(
            r#"{{
      "schemaVersion":6,"fileId":1,"compilerRevision":"x",
      "symbols":[{{"id":1,"name":"run","kind":"function","typeRepr":"() => void","overloads":[],"effectParameters":[],"span":{{"start":0,"end":1}}}}],
      "calls":[],"trivia":[],"protocolSymbols":[],
      "promiseObservations":[{{"owner":1,"source":"task()","observation":"await","catchesRejection":false,"conditional":true,"controlConditions":{conditions},"controlPaths":[{conditions}],"span":{{"start":1,"end":2}}}}]
    }}"#
        )
    };
    assert!(consume_corsa_json(&input(r#"[{"id":"","expected":true}]"#)).is_err());
    assert!(
        consume_corsa_json(&input(
            r#"[{"id":"if:1","expected":true},{"id":"if:1","expected":false}]"#
        ))
        .is_err()
    );
    let mismatched_primary = r#"{
      "schemaVersion":6,"fileId":1,"compilerRevision":"x",
      "symbols":[{"id":1,"name":"run","kind":"function","typeRepr":"() => void","overloads":[],"effectParameters":[],"span":{"start":0,"end":1}}],
      "calls":[],"trivia":[],"protocolSymbols":[],
      "promiseObservations":[{"owner":1,"source":"task()","observation":"await","catchesRejection":false,"conditional":true,"controlConditions":[{"id":"case:0","expected":true}],"controlPaths":[[{"id":"case:0","expected":false}],[{"id":"case:1","expected":true}]],"span":{"start":1,"end":2}}]
    }"#;
    assert!(
        consume_corsa_json(mismatched_primary)
            .unwrap_err()
            .to_string()
            .contains("primary control conditions")
    );
}
