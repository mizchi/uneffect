use crate::{Effect, EffectSet, ParseEffectError, SourceSpan};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

pub const CORSA_FRONTEND_SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CorsaFrontendFile {
    pub schema_version: u32,
    pub file_id: u32,
    pub compiler_revision: String,
    pub symbols: Vec<CorsaSymbol>,
    pub calls: Vec<CorsaCall>,
    pub trivia: Vec<CorsaTrivia>,
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
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedFrontendProgram {
    pub schema_version: u32,
    pub functions: Vec<NormalizedFunction>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedFunction {
    pub name: String,
    pub effects: Vec<String>,
}

impl NativeFrontendProgram {
    pub fn normalized(&self) -> NormalizedFrontendProgram {
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
    Ok(NativeFrontendProgram {
        compiler_revision: file.compiler_revision,
        symbols,
        calls: file.calls,
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
