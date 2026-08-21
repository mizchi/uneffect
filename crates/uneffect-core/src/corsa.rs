use crate::{Effect, EffectSet, ParseEffectError, SourceSpan};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

pub const CORSA_FRONTEND_SCHEMA_VERSION: u32 = 3;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CorsaFrontendFile {
    pub schema_version: u32,
    pub file_id: u32,
    pub compiler_revision: String,
    pub symbols: Vec<CorsaSymbol>,
    pub calls: Vec<CorsaCall>,
    pub trivia: Vec<CorsaTrivia>,
    pub protocol_symbols: Vec<CorsaProtocolSymbol>,
    #[serde(default)]
    pub promise_observations: Vec<CorsaPromiseObservation>,
    #[serde(default)]
    pub rejection_ownership: Vec<CorsaRejectionOwnership>,
    #[serde(default)]
    pub resource_scopes: Vec<CorsaResourceScope>,
    #[serde(default)]
    pub disposals: Vec<CorsaDisposal>,
    #[serde(default)]
    pub suppressed_errors: Vec<CorsaSuppressedError>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CorsaSymbol {
    pub id: u64,
    pub name: String,
    pub kind: CorsaSymbolKind,
    pub type_repr: String,
    pub overloads: Vec<String>,
    pub effect_parameters: Vec<usize>,
    pub span: SourceSpanDto,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CorsaSymbolKind {
    Function,
    Method,
    Arrow,
    Callback,
    Overload,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CorsaCall {
    pub caller: u64,
    pub callee: u64,
    pub overload_index: Option<usize>,
    pub callback_timing: CallbackTiming,
    pub span: SourceSpanDto,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CallbackTiming {
    None,
    Inline,
    Deferred,
    Unknown,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CorsaTrivia {
    pub owner: u64,
    pub text: String,
    pub span: SourceSpanDto,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CorsaProtocolSymbol {
    pub id: u64,
    pub kind: CorsaDisposalProtocolKind,
    pub file_name: String,
    pub span: SourceSpanDto,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CorsaDisposalProtocolKind {
    Sync,
    Async,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CorsaPromiseObservation {
    pub owner: u64,
    pub source: String,
    pub observation: String,
    pub catches_rejection: bool,
    pub span: SourceSpanDto,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CorsaRejectionOwnership {
    pub owner: u64,
    pub binding: String,
    pub status: String,
    pub observations: Vec<String>,
    pub span: SourceSpanDto,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CorsaResourceScope {
    pub owner: u64,
    pub binding: String,
    pub owner_async: bool,
    pub asynchronous: bool,
    pub acquisition_index: usize,
    pub scope_id: String,
    pub scope_depth: usize,
    pub scope_end: u32,
    pub catches_failure: bool,
    pub disposal_failure_type: String,
    pub protocol_symbol: Option<u64>,
    pub protocol_kind: Option<CorsaDisposalProtocolKind>,
    pub span: SourceSpanDto,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CorsaDisposal {
    pub owner: u64,
    pub binding: String,
    pub order: usize,
    pub asynchronous: bool,
    pub scope_id: String,
    pub scope_depth: usize,
    pub disposal_point: u32,
    pub failure_kind: String,
    pub failure_type: String,
    pub catches_failure: bool,
    pub escaping_failure: String,
    pub exits: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CorsaSuppressedError {
    pub owner: u64,
    pub payload: CorsaResourceError,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CorsaResourceError {
    Error {
        error_type: String,
        source: String,
    },
    Suppressed {
        error: Box<CorsaResourceError>,
        suppressed: Box<CorsaResourceError>,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceSpanDto {
    pub start: u32,
    pub end: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeEvidence {
    Trusted,
    Inferred,
    Unknown,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeSymbolSummary {
    pub id: u64,
    pub name: String,
    pub kind: CorsaSymbolKind,
    pub type_repr: String,
    pub overloads: Vec<String>,
    pub effect_parameters: Vec<usize>,
    pub effects: EffectSet,
    pub evidence: NativeEvidence,
    pub span: SourceSpan,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeFrontendProgram {
    pub compiler_revision: String,
    pub symbols: BTreeMap<u64, NativeSymbolSummary>,
    pub calls: Vec<CorsaCall>,
    pub protocol_symbols: BTreeMap<u64, CorsaProtocolSymbol>,
    pub promise_observations: Vec<CorsaPromiseObservation>,
    pub rejection_ownership: Vec<CorsaRejectionOwnership>,
    pub resource_scopes: Vec<CorsaResourceScope>,
    pub disposals: Vec<CorsaDisposal>,
    pub suppressed_errors: Vec<CorsaSuppressedError>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedFrontendProgram {
    pub schema_version: u32,
    pub functions: Vec<NormalizedFunction>,
    pub calls: Vec<NormalizedCall>,
    pub ordered_events: Vec<NormalizedCallEvent>,
    pub protocol_symbols: Vec<NormalizedProtocolSymbol>,
    pub promise_observations: Vec<NormalizedPromiseObservation>,
    pub rejection_ownership: Vec<NormalizedRejectionOwnership>,
    pub resource_scopes: Vec<NormalizedResourceScope>,
    pub disposals: Vec<NormalizedDisposal>,
    pub suppressed_errors: Vec<NormalizedSuppressedError>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedFunction {
    pub name: String,
    pub effects: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedCall {
    pub caller: String,
    pub callee: String,
    pub callback_timing: CallbackTiming,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedCallEvent {
    pub kind: &'static str,
    pub caller: String,
    pub callee: String,
    pub start: u32,
    pub end: u32,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedProtocolSymbol {
    pub id: u64,
    pub kind: CorsaDisposalProtocolKind,
    pub file_name: String,
    pub start: u32,
    pub end: u32,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedPromiseObservation {
    pub owner: String,
    pub source: String,
    pub observation: String,
    pub catches_rejection: bool,
    pub start: u32,
    pub end: u32,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedRejectionOwnership {
    pub owner: String,
    pub binding: String,
    pub status: String,
    pub observations: Vec<String>,
    pub start: u32,
    pub end: u32,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedResourceScope {
    pub owner: String,
    pub binding: String,
    pub owner_async: bool,
    pub asynchronous: bool,
    pub acquisition_index: usize,
    pub scope_id: String,
    pub scope_depth: usize,
    pub scope_end: u32,
    pub catches_failure: bool,
    pub disposal_failure_type: String,
    pub protocol_symbol: Option<u64>,
    pub protocol_kind: Option<CorsaDisposalProtocolKind>,
    pub start: u32,
    pub end: u32,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedDisposal {
    pub owner: String,
    pub binding: String,
    pub order: usize,
    pub asynchronous: bool,
    pub scope_id: String,
    pub scope_depth: usize,
    pub disposal_point: u32,
    pub failure_kind: String,
    pub failure_type: String,
    pub catches_failure: bool,
    pub escaping_failure: String,
    pub exits: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedSuppressedError {
    pub owner: String,
    pub payload: CorsaResourceError,
}

impl NativeFrontendProgram {
    pub fn normalized(&self) -> NormalizedFrontendProgram {
        let calls = self
            .calls
            .iter()
            .map(|call| NormalizedCall {
                caller: self.symbols[&call.caller].name.clone(),
                callee: self.symbols[&call.callee].name.clone(),
                callback_timing: call.callback_timing,
            })
            .collect();
        let mut ordered_events: Vec<_> = self
            .calls
            .iter()
            .map(|call| NormalizedCallEvent {
                kind: "call",
                caller: self.symbols[&call.caller].name.clone(),
                callee: self.symbols[&call.callee].name.clone(),
                start: call.span.start,
                end: call.span.end,
            })
            .collect();
        ordered_events.sort_by_key(|event| (event.start, event.end));
        NormalizedFrontendProgram {
            schema_version: CORSA_FRONTEND_SCHEMA_VERSION,
            functions: self
                .symbols
                .values()
                .map(|symbol| NormalizedFunction {
                    name: symbol.name.clone(),
                    effects: symbol.effects.iter().map(Effect::canonical).collect(),
                })
                .collect(),
            calls,
            ordered_events,
            protocol_symbols: self
                .protocol_symbols
                .values()
                .map(|item| NormalizedProtocolSymbol {
                    id: item.id,
                    kind: item.kind,
                    file_name: item.file_name.clone(),
                    start: item.span.start,
                    end: item.span.end,
                })
                .collect(),
            promise_observations: self
                .promise_observations
                .iter()
                .map(|item| NormalizedPromiseObservation {
                    owner: self.symbols[&item.owner].name.clone(),
                    source: item.source.clone(),
                    observation: item.observation.clone(),
                    catches_rejection: item.catches_rejection,
                    start: item.span.start,
                    end: item.span.end,
                })
                .collect(),
            rejection_ownership: self
                .rejection_ownership
                .iter()
                .map(|item| NormalizedRejectionOwnership {
                    owner: self.symbols[&item.owner].name.clone(),
                    binding: item.binding.clone(),
                    status: item.status.clone(),
                    observations: item.observations.clone(),
                    start: item.span.start,
                    end: item.span.end,
                })
                .collect(),
            resource_scopes: self
                .resource_scopes
                .iter()
                .map(|item| NormalizedResourceScope {
                    owner: self.symbols[&item.owner].name.clone(),
                    binding: item.binding.clone(),
                    owner_async: item.owner_async,
                    asynchronous: item.asynchronous,
                    acquisition_index: item.acquisition_index,
                    scope_id: item.scope_id.clone(),
                    scope_depth: item.scope_depth,
                    scope_end: item.scope_end,
                    catches_failure: item.catches_failure,
                    disposal_failure_type: item.disposal_failure_type.clone(),
                    protocol_symbol: item.protocol_symbol,
                    protocol_kind: item.protocol_kind,
                    start: item.span.start,
                    end: item.span.end,
                })
                .collect(),
            disposals: self
                .disposals
                .iter()
                .map(|item| NormalizedDisposal {
                    owner: self.symbols[&item.owner].name.clone(),
                    binding: item.binding.clone(),
                    order: item.order,
                    asynchronous: item.asynchronous,
                    scope_id: item.scope_id.clone(),
                    scope_depth: item.scope_depth,
                    disposal_point: item.disposal_point,
                    failure_kind: item.failure_kind.clone(),
                    failure_type: item.failure_type.clone(),
                    catches_failure: item.catches_failure,
                    escaping_failure: item.escaping_failure.clone(),
                    exits: item.exits.clone(),
                })
                .collect(),
            suppressed_errors: self
                .suppressed_errors
                .iter()
                .map(|item| NormalizedSuppressedError {
                    owner: self.symbols[&item.owner].name.clone(),
                    payload: item.payload.clone(),
                })
                .collect(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CorsaFrontendError(String);
impl std::fmt::Display for CorsaFrontendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for CorsaFrontendError {}
impl From<ParseEffectError> for CorsaFrontendError {
    fn from(value: ParseEffectError) -> Self {
        Self(value.to_string())
    }
}

fn effect_payloads(text: &str) -> Vec<&str> {
    let mut inside = false;
    let mut values = Vec::new();
    for raw in text.lines() {
        let line = raw
            .trim()
            .trim_start_matches("/*")
            .trim_start_matches('*')
            .trim_end_matches("*/")
            .trim();
        let tail = if let Some((_, tail)) = line.split_once("uneffect:") {
            inside = true;
            tail.trim()
        } else if inside {
            line
        } else {
            continue;
        };
        if let Some(value) = tail.strip_prefix("effect ") {
            values.push(value.trim());
        }
    }
    values
}

pub fn consume_corsa_json(json: &str) -> Result<NativeFrontendProgram, CorsaFrontendError> {
    let file: CorsaFrontendFile =
        serde_json::from_str(json).map_err(|error| CorsaFrontendError(error.to_string()))?;
    if file.schema_version != CORSA_FRONTEND_SCHEMA_VERSION {
        return Err(CorsaFrontendError(format!(
            "unsupported Corsa frontend schema {}",
            file.schema_version
        )));
    }
    let mut ids = BTreeSet::new();
    let mut symbols = BTreeMap::new();
    for symbol in file.symbols {
        if !ids.insert(symbol.id) {
            return Err(CorsaFrontendError(format!(
                "duplicate Corsa symbol {}",
                symbol.id
            )));
        }
        if symbol.span.start > symbol.span.end {
            return Err(CorsaFrontendError(format!(
                "invalid span for symbol {}",
                symbol.id
            )));
        }
        symbols.insert(
            symbol.id,
            NativeSymbolSummary {
                id: symbol.id,
                name: symbol.name,
                kind: symbol.kind,
                type_repr: symbol.type_repr,
                overloads: symbol.overloads,
                effect_parameters: symbol.effect_parameters,
                effects: EffectSet::default(),
                evidence: NativeEvidence::Inferred,
                span: SourceSpan::new(file.file_id, symbol.span.start, symbol.span.end),
            },
        );
    }
    for trivia in file.trivia {
        let summary = symbols.get_mut(&trivia.owner).ok_or_else(|| {
            CorsaFrontendError(format!("trivia owner {} is unknown", trivia.owner))
        })?;
        for payload in effect_payloads(&trivia.text) {
            let effects = EffectSet::parse(payload)?;
            summary.effects = EffectSet::from_iter(
                summary
                    .effects
                    .iter()
                    .cloned()
                    .chain(effects.iter().cloned()),
            );
            summary.evidence = NativeEvidence::Trusted;
        }
    }
    for call in &file.calls {
        if !symbols.contains_key(&call.caller) || !symbols.contains_key(&call.callee) {
            return Err(CorsaFrontendError(
                "call references an unknown symbol".into(),
            ));
        }
        if let Some(index) = call.overload_index {
            if index >= symbols[&call.callee].overloads.len() {
                return Err(CorsaFrontendError(format!(
                    "invalid overload index {index}"
                )));
            }
        }
    }
    let mut protocol_symbols = BTreeMap::new();
    for protocol in file.protocol_symbols {
        if protocol.span.start > protocol.span.end {
            return Err(CorsaFrontendError(format!(
                "invalid span for disposal protocol {}",
                protocol.id
            )));
        }
        if protocol_symbols.insert(protocol.id, protocol).is_some() {
            return Err(CorsaFrontendError(
                "duplicate disposal protocol symbol".into(),
            ));
        }
    }
    for resource in &file.resource_scopes {
        match (resource.protocol_symbol, resource.protocol_kind) {
            (Some(id), Some(kind))
                if protocol_symbols
                    .get(&id)
                    .is_some_and(|symbol| symbol.kind == kind) => {}
            (None, None) => {}
            (Some(id), _) if !protocol_symbols.contains_key(&id) => {
                return Err(CorsaFrontendError(format!(
                    "resource references unknown disposal protocol symbol {id}"
                )));
            }
            _ => {
                return Err(CorsaFrontendError(
                    "resource disposal protocol kind does not match its symbol".into(),
                ));
            }
        }
    }
    for owner in file
        .promise_observations
        .iter()
        .map(|item| item.owner)
        .chain(file.rejection_ownership.iter().map(|item| item.owner))
        .chain(file.resource_scopes.iter().map(|item| item.owner))
        .chain(file.disposals.iter().map(|item| item.owner))
        .chain(file.suppressed_errors.iter().map(|item| item.owner))
    {
        if !symbols.contains_key(&owner) {
            return Err(CorsaFrontendError(
                "async record references an unknown symbol".into(),
            ));
        }
    }
    let mut changed = true;
    while changed {
        changed = false;
        for call in &file.calls {
            let callee_effects: Vec<_> = symbols[&call.callee].effects.iter().cloned().collect();
            let caller = symbols.get_mut(&call.caller).expect("validated caller");
            let before = caller.effects.iter().count();
            for effect in callee_effects {
                caller.effects.insert(effect);
            }
            changed |= caller.effects.iter().count() != before;
        }
    }
    Ok(NativeFrontendProgram {
        compiler_revision: file.compiler_revision,
        symbols,
        calls: file.calls,
        protocol_symbols,
        promise_observations: file.promise_observations,
        rejection_ownership: file.rejection_ownership,
        resource_scopes: file.resource_scopes,
        disposals: file.disposals,
        suppressed_errors: file.suppressed_errors,
    })
}

impl FromIterator<Effect> for EffectSet {
    fn from_iter<T: IntoIterator<Item = Effect>>(iter: T) -> Self {
        let mut result = EffectSet::default();
        for effect in iter {
            result.insert(effect);
        }
        result
    }
}
