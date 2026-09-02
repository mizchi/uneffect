use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt::{self, Display};

pub mod corsa;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TargetCasePolicy {
    Sensitive,
    Insensitive,
}

fn target_fold(value: &str, policy: TargetCasePolicy) -> String {
    let normalized = value.replace('\\', "/");
    match policy {
        TargetCasePolicy::Sensitive => normalized,
        TargetCasePolicy::Insensitive => normalized.to_ascii_lowercase(),
    }
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct Region(String);

impl Region {
    pub fn new(value: impl Into<String>) -> Result<Self, ParseEffectError> {
        let value = value.into();
        if is_region_path(&value) {
            Ok(Self(value))
        } else {
            Err(ParseEffectError::new(format!(
                "invalid mutation region `{value}`"
            )))
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    fn is_within(&self, allowed: &Region) -> bool {
        self == allowed
            || self
                .0
                .strip_prefix(&allowed.0)
                .is_some_and(|rest| rest.starts_with('.') || rest.starts_with('['))
    }

    pub fn overlaps(&self, other: &Region) -> bool {
        self.is_within(other) || other.is_within(self)
    }
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum Effect {
    Named(String),
    Mutate(Region),
    Throw(String),
    Capability(Capability),
}

impl Effect {
    pub fn canonical(&self) -> String {
        match self {
            Self::Named(name) => name.clone(),
            Self::Mutate(region) => format!("Mutate<typeof {}>", region.as_str()),
            Self::Throw(error) => format!("Throw<{error}>"),
            Self::Capability(capability) => capability.canonical(),
        }
    }
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct Capability {
    name: String,
    arguments: Vec<CapabilitySet>,
}

impl Capability {
    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn arguments(&self) -> &[CapabilitySet] {
        &self.arguments
    }

    fn permits(&self, actual: &Capability) -> bool {
        self.name == actual.name
            && self.arguments.len() == actual.arguments.len()
            && self
                .arguments
                .iter()
                .zip(&actual.arguments)
                .all(|(allowed, actual)| allowed.permits(actual))
    }

    fn canonical(&self) -> String {
        if self.arguments.is_empty()
            || self
                .arguments
                .iter()
                .all(|argument| matches!(argument, CapabilitySet::All))
        {
            return self.name.clone();
        }
        let arguments = self
            .arguments
            .iter()
            .map(CapabilitySet::canonical)
            .collect::<Vec<_>>()
            .join(", ");
        format!("{}<{arguments}>", self.name)
    }
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum CapabilitySet {
    All,
    Finite(BTreeSet<CapabilityAtom>),
    Unknown(String),
}

impl CapabilitySet {
    fn canonical(&self) -> String {
        match self {
            Self::All => "All".into(),
            Self::Unknown(reason) => format!("Unknown<{reason}>"),
            Self::Finite(atoms) => atoms
                .iter()
                .map(CapabilityAtom::canonical)
                .collect::<Vec<_>>()
                .join(" | "),
        }
    }

    fn permits(&self, actual: &CapabilitySet) -> bool {
        match (self, actual) {
            (Self::All, _) => true,
            (Self::Unknown(allowed), Self::Unknown(actual)) => allowed == actual,
            (Self::Finite(allowed), Self::Finite(actual)) => actual
                .iter()
                .all(|atom| allowed.iter().any(|candidate| candidate.covers(atom))),
            _ => false,
        }
    }
}

impl CapabilityAtom {
    fn canonical(&self) -> String {
        match self {
            Self::Token(value) | Self::Sys(value) => value.clone(),
            Self::Region(value) => format!("typeof {}", value.as_str()),
            Self::Literal(value) => {
                serde_json::to_string(value).expect("string serialization cannot fail")
            }
            Self::Url(value) => {
                serde_json::to_string(&value.0).expect("string serialization cannot fail")
            }
            Self::Path(value) => {
                serde_json::to_string(&value.canonical()).expect("string serialization cannot fail")
            }
            Self::Host(value) => serde_json::to_string(&value.as_deno_scope())
                .expect("string serialization cannot fail"),
            Self::Env(value) => serde_json::to_string(&format!(
                "{}{}",
                value.prefix,
                if value.wildcard { "*" } else { "" }
            ))
            .expect("string serialization cannot fail"),
        }
    }
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum CapabilityAtom {
    Token(String),
    Literal(String),
    Region(Region),
    Url(ScopePattern),
    Path(PathPattern),
    Host(HostPattern),
    Env(EnvPattern),
    Sys(String),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AtomDomain {
    Token,
    Literal,
    Region,
    Url,
    Path,
    Host,
    Env,
    Sys,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EffectSchema {
    version: u32,
    arguments: Vec<AtomDomain>,
}

impl EffectSchema {
    pub fn new(version: u32, arguments: Vec<AtomDomain>) -> Self {
        Self { version, arguments }
    }

    pub fn version(&self) -> u32 {
        self.version
    }

    pub fn arguments(&self) -> &[AtomDomain] {
        &self.arguments
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct EffectSchemaRegistry(BTreeMap<String, EffectSchema>);

impl EffectSchemaRegistry {
    pub fn with_builtins() -> Self {
        let mut registry = Self::default();
        for (name, arguments) in [
            ("CookieRead", vec![AtomDomain::Literal]),
            ("CookieWrite", vec![AtomDomain::Literal]),
            ("LocalStorageRead", vec![AtomDomain::Literal]),
            ("LocalStorageWrite", vec![AtomDomain::Literal]),
            ("GlobalVarsRead", vec![AtomDomain::Literal]),
            ("GlobalVarsWrite", vec![AtomDomain::Literal]),
            ("Fetch", vec![AtomDomain::Token, AtomDomain::Url]),
            ("ScriptLoad", vec![AtomDomain::Token, AtomDomain::Url]),
            (
                "ExecuteExternalCode",
                vec![AtomDomain::Url, AtomDomain::Literal],
            ),
            ("Dom", vec![AtomDomain::Token, AtomDomain::Region]),
            ("FsRead", vec![AtomDomain::Path]),
            ("FsWrite", vec![AtomDomain::Path]),
            ("Ffi", vec![AtomDomain::Path]),
            ("Net", vec![AtomDomain::Host]),
            ("Env", vec![AtomDomain::Env]),
            ("Run", vec![AtomDomain::Literal]),
            ("Import", vec![AtomDomain::Host]),
            ("Sys", vec![AtomDomain::Sys]),
        ] {
            registry.register(name, EffectSchema::new(1, arguments));
        }
        registry
    }

    pub fn register(&mut self, name: impl Into<String>, schema: EffectSchema) {
        self.0.insert(name.into(), schema);
    }

    pub fn get(&self, name: &str) -> Option<&EffectSchema> {
        self.0.get(name)
    }
}

pub fn builtin_effect_schema(name: &str) -> Option<EffectSchema> {
    EffectSchemaRegistry::with_builtins().get(name).cloned()
}

impl CapabilityAtom {
    fn covers(&self, actual: &CapabilityAtom) -> bool {
        match (self, actual) {
            (Self::Url(allowed), Self::Url(actual)) => allowed.covers(actual),
            (Self::Path(allowed), Self::Path(actual)) => allowed.covers(actual),
            (Self::Host(allowed), Self::Host(actual)) => allowed.covers(actual),
            (Self::Env(allowed), Self::Env(actual)) => allowed.covers(actual),
            _ => self == actual,
        }
    }
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct HostPattern {
    host: String,
    port: Option<u16>,
    subdomains: bool,
}

impl HostPattern {
    pub fn new(value: &str) -> Result<Self, ParseEffectError> {
        if value.contains("//")
            || value.contains('/')
            || value.contains('@')
            || value.chars().any(char::is_whitespace)
        {
            return Err(ParseEffectError::new(
                "host scope must contain only host and optional port",
            ));
        }
        let (host_port, subdomains) = value
            .strip_prefix("*.")
            .map_or((value, false), |rest| (rest, true));
        let (host, port) = if let Some(rest) = host_port.strip_prefix('[') {
            let end = rest
                .find(']')
                .ok_or_else(|| ParseEffectError::new("unclosed IPv6 host"))?;
            let host = &rest[..end];
            let suffix = &rest[end + 1..];
            let port = if suffix.is_empty() {
                None
            } else {
                Some(
                    suffix
                        .strip_prefix(':')
                        .ok_or_else(|| ParseEffectError::new("invalid IPv6 port"))?
                        .parse::<u16>()
                        .map_err(|_| ParseEffectError::new("invalid host port"))?,
                )
            };
            (host, port)
        } else if let Some((host, port)) = host_port.rsplit_once(':') {
            if host.contains(':') {
                return Err(ParseEffectError::new("IPv6 hosts must use brackets"));
            }
            (
                host,
                Some(
                    port.parse::<u16>()
                        .map_err(|_| ParseEffectError::new("invalid host port"))?,
                ),
            )
        } else {
            (host_port, None)
        };
        if host.is_empty()
            || host.contains('*')
            || (!host.contains(':')
                && host.split('.').any(|label| {
                    label.is_empty()
                        || !label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
                }))
        {
            return Err(ParseEffectError::new("invalid host scope"));
        }
        Ok(Self {
            host: host.to_ascii_lowercase(),
            port,
            subdomains,
        })
    }

    pub fn covers(&self, actual: &Self) -> bool {
        let host_matches = if self.subdomains {
            !actual.subdomains
                && actual.host != self.host
                && actual.host.ends_with(&format!(".{}", self.host))
        } else {
            self.host == actual.host && self.subdomains == actual.subdomains
        };
        host_matches && self.port.is_none_or(|port| actual.port == Some(port))
    }

    pub fn as_deno_scope(&self) -> String {
        let host = if self.host.contains(':') {
            format!("[{}]", self.host)
        } else {
            self.host.clone()
        };
        format!(
            "{}{}{}",
            if self.subdomains { "*." } else { "" },
            host,
            self.port.map_or(String::new(), |port| format!(":{port}"))
        )
    }
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct EnvPattern {
    prefix: String,
    wildcard: bool,
}

impl EnvPattern {
    pub fn new(value: &str) -> Result<Self, ParseEffectError> {
        let wildcard = value.ends_with('*');
        let prefix = value.strip_suffix('*').unwrap_or(value);
        if prefix.is_empty()
            || prefix.contains('*')
            || !prefix
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_')
        {
            return Err(ParseEffectError::new(
                "environment scope supports only a final `*` wildcard",
            ));
        }
        Ok(Self {
            prefix: prefix.to_owned(),
            wildcard,
        })
    }

    fn covers(&self, actual: &Self) -> bool {
        self.covers_with_policy(actual, TargetCasePolicy::Sensitive)
    }

    pub fn covers_with_policy(&self, actual: &Self, policy: TargetCasePolicy) -> bool {
        let allowed = target_fold(&self.prefix, policy);
        let actual_prefix = target_fold(&actual.prefix, policy);
        !actual.wildcard
            && if self.wildcard {
                actual_prefix.starts_with(&allowed)
            } else {
                allowed == actual_prefix
            }
    }
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum PathAnchor {
    WorkspaceRoot,
    PackageRoot,
    SourceDir,
    Cwd,
    Temp,
    Absolute,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct PathPattern {
    anchor: PathAnchor,
    segments: Vec<String>,
    recursive: bool,
}

impl PathPattern {
    fn canonical(&self) -> String {
        let anchor = match self.anchor {
            PathAnchor::WorkspaceRoot => "$WORKSPACE_ROOT",
            PathAnchor::PackageRoot => "$PACKAGE_ROOT",
            PathAnchor::SourceDir => "$SOURCE_DIR",
            PathAnchor::Cwd => "$CWD",
            PathAnchor::Temp => "$TEMP",
            PathAnchor::Absolute => "",
        };
        let prefix = if self.anchor == PathAnchor::Absolute {
            "/".to_owned()
        } else {
            anchor.to_owned()
        };
        let body = self.segments.join("/");
        format!("{prefix}{}{}", if body.is_empty() { "" } else { "/" }, body)
            + if self.recursive { "/**" } else { "" }
    }

    pub fn new(value: &str) -> Result<Self, ParseEffectError> {
        let (anchor, remainder) = if let Some(value) = strip_path_anchor(value, "$WORKSPACE_ROOT") {
            (PathAnchor::WorkspaceRoot, value)
        } else if let Some(value) = strip_path_anchor(value, "$PACKAGE_ROOT") {
            (PathAnchor::PackageRoot, value)
        } else if let Some(value) = strip_path_anchor(value, "$SOURCE_DIR") {
            (PathAnchor::SourceDir, value)
        } else if let Some(value) = strip_path_anchor(value, "$CWD") {
            (PathAnchor::Cwd, value)
        } else if let Some(value) = strip_path_anchor(value, "$TEMP") {
            (PathAnchor::Temp, value)
        } else if value.starts_with('$') {
            return Err(ParseEffectError::new("unknown symbolic path anchor"));
        } else if let Some(value) = value.strip_prefix('/') {
            (PathAnchor::Absolute, value)
        } else if let Some(value) = value.strip_prefix("./") {
            (PathAnchor::Cwd, value)
        } else {
            (PathAnchor::Cwd, value)
        };
        let remainder = remainder.strip_prefix('/').unwrap_or(remainder);
        let mut raw_segments = remainder
            .split('/')
            .filter(|segment| !segment.is_empty() && *segment != ".")
            .collect::<Vec<_>>();
        let recursive = raw_segments.last() == Some(&"**");
        if recursive {
            raw_segments.pop();
        }
        if raw_segments
            .iter()
            .any(|segment| *segment == ".." || segment.contains('*'))
        {
            return Err(ParseEffectError::new(
                "path patterns support only a final `/**` recursive selector",
            ));
        }
        Ok(Self {
            anchor,
            segments: raw_segments.into_iter().map(str::to_owned).collect(),
            recursive,
        })
    }

    pub fn anchor(&self) -> &PathAnchor {
        &self.anchor
    }

    pub fn segments(&self) -> &[String] {
        &self.segments
    }

    pub fn is_recursive(&self) -> bool {
        self.recursive
    }

    pub fn covers(&self, actual: &PathPattern) -> bool {
        self.anchor == actual.anchor
            && if self.recursive {
                actual.segments.starts_with(&self.segments)
            } else {
                self.segments == actual.segments && !actual.recursive
            }
    }

    pub fn covers_with_bindings(
        &self,
        actual: &PathPattern,
        bindings: &BTreeMap<PathAnchor, String>,
        policy: TargetCasePolicy,
    ) -> bool {
        let Some(allowed_root) = bindings.get(&self.anchor) else {
            return false;
        };
        let Some(actual_root) = bindings.get(&actual.anchor) else {
            return false;
        };
        let allowed = target_fold(
            &format!(
                "{}/{}",
                allowed_root.trim_end_matches(['/', '\\']),
                self.segments.join("/")
            ),
            policy,
        );
        let actual_path = target_fold(
            &format!(
                "{}/{}",
                actual_root.trim_end_matches(['/', '\\']),
                actual.segments.join("/")
            ),
            policy,
        );
        if self.recursive {
            actual_path == allowed || actual_path.starts_with(&format!("{allowed}/"))
        } else {
            !actual.recursive && actual_path == allowed
        }
    }
}

fn strip_path_anchor<'a>(value: &'a str, anchor: &str) -> Option<&'a str> {
    value
        .strip_prefix(anchor)
        .filter(|remainder| remainder.is_empty() || remainder.starts_with('/'))
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct ScopePattern(String);

impl ScopePattern {
    pub fn new(value: impl Into<String>) -> Result<Self, ParseEffectError> {
        let value = value.into();
        let (origin, path, query) = split_url_scope(&value)?;
        Ok(Self(format!(
            "{origin}{path}{}",
            query.map_or(String::new(), |q| format!("?{q}"))
        )))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn covers(&self, actual: &ScopePattern) -> bool {
        let Ok((allowed_origin, allowed_path, allowed_query)) = split_url_scope(&self.0) else {
            return false;
        };
        let Ok((actual_origin, actual_path, actual_query)) = split_url_scope(&actual.0) else {
            return false;
        };
        allowed_origin == actual_origin
            && allowed_query
                .as_ref()
                .is_none_or(|query| actual_query.as_ref() == Some(query))
            && path_pattern_covers(
                &allowed_path.split('/').collect::<Vec<_>>(),
                &actual_path.split('/').collect::<Vec<_>>(),
            )
    }
}

impl Effect {
    pub fn substitute_region(&self, parameter: &str, argument: &str) -> Self {
        let Self::Mutate(region) = self else {
            return self.clone();
        };
        let Some(rest) = region.as_str().strip_prefix(parameter) else {
            return self.clone();
        };
        if !rest.is_empty() && !rest.starts_with('.') && !rest.starts_with('[') {
            return self.clone();
        }
        Region::new(format!("{argument}{rest}"))
            .map(Self::Mutate)
            .unwrap_or_else(|_| self.clone())
    }

    fn permits(&self, actual: &Effect) -> bool {
        match (self, actual) {
            (Self::Named(allowed), Self::Named(actual)) => allowed == actual,
            (Self::Mutate(allowed), Self::Mutate(actual)) => actual.is_within(allowed),
            (Self::Throw(allowed), Self::Throw(actual)) => {
                allowed == actual || (allowed == "Error" && actual != "unknown")
            }
            (Self::Capability(allowed), Self::Capability(actual)) => allowed.permits(actual),
            _ => false,
        }
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct EffectSet(BTreeSet<Effect>);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SourceSpan {
    file_id: u32,
    start: u32,
    end: u32,
}

impl SourceSpan {
    pub fn new(file_id: u32, start: u32, end: u32) -> Self {
        Self {
            file_id,
            start,
            end,
        }
    }

    pub fn file_id(&self) -> u32 {
        self.file_id
    }

    pub fn start(&self) -> u32 {
        self.start
    }

    pub fn end(&self) -> u32 {
        self.end
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocatedEffect {
    value: Effect,
    span: SourceSpan,
}

impl LocatedEffect {
    pub fn value(&self) -> &Effect {
        &self.value
    }

    pub fn span(&self) -> SourceSpan {
        self.span
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocatedEffectSet {
    effects: Vec<LocatedEffect>,
    effect_set: EffectSet,
}

impl LocatedEffectSet {
    pub fn effects(&self) -> &[LocatedEffect] {
        &self.effects
    }

    pub fn effect_set(&self) -> &EffectSet {
        &self.effect_set
    }
}

impl EffectSet {
    pub fn parse(input: &str) -> Result<Self, ParseEffectError> {
        Self::parse_with_schemas(input, &EffectSchemaRegistry::with_builtins())
    }

    pub fn parse_with_schemas(
        input: &str,
        schemas: &EffectSchemaRegistry,
    ) -> Result<Self, ParseEffectError> {
        let terms = split_union(input)?;
        if terms.iter().any(|term| *term == "none") {
            if terms.len() != 1 {
                return Err(ParseEffectError::new(
                    "`none` must be the only member of an effect set",
                ));
            }
            return Ok(Self::default());
        }
        let mut effects = BTreeSet::new();
        for term in terms {
            effects.insert(parse_effect(term, schemas)?);
        }
        if effects.is_empty() {
            return Err(ParseEffectError::new("effect union is empty"));
        }
        Ok(Self(effects))
    }

    pub fn parse_located(
        input: &str,
        file_id: u32,
        base_offset: u32,
    ) -> Result<LocatedEffectSet, ParseEffectError> {
        Self::parse_located_with_schemas(
            input,
            file_id,
            base_offset,
            &EffectSchemaRegistry::with_builtins(),
        )
    }

    pub fn parse_located_with_schemas(
        input: &str,
        file_id: u32,
        base_offset: u32,
        schemas: &EffectSchemaRegistry,
    ) -> Result<LocatedEffectSet, ParseEffectError> {
        let terms = split_union(input).map_err(|error| {
            let start = invalid_member_start(input);
            error.at(SourceSpan::new(
                file_id,
                base_offset.saturating_add(start as u32),
                base_offset.saturating_add(input.len() as u32),
            ))
        })?;
        if terms.iter().any(|term| *term == "none") {
            if terms.len() != 1 {
                return Err(ParseEffectError::new(
                    "`none` must be the only member of an effect set",
                )
                .at(SourceSpan::new(
                    file_id,
                    base_offset,
                    base_offset.saturating_add(input.len() as u32),
                )));
            }
            return Ok(LocatedEffectSet {
                effects: Vec::new(),
                effect_set: Self::default(),
            });
        }
        let mut effects = Vec::with_capacity(terms.len());
        let mut semantic = BTreeSet::new();
        for term in terms {
            let start = term.as_ptr() as usize - input.as_ptr() as usize;
            let span = SourceSpan::new(
                file_id,
                base_offset.saturating_add(start as u32),
                base_offset.saturating_add((start + term.len()) as u32),
            );
            let value = parse_effect(term, schemas).map_err(|error| error.at(span))?;
            semantic.insert(value.clone());
            effects.push(LocatedEffect { value, span });
        }
        if effects.is_empty() {
            return Err(
                ParseEffectError::new("effect union is empty").at(SourceSpan::new(
                    file_id,
                    base_offset,
                    base_offset.saturating_add(input.len() as u32),
                )),
            );
        }
        Ok(LocatedEffectSet {
            effects,
            effect_set: Self(semantic),
        })
    }

    pub fn contains(&self, effect: &Effect) -> bool {
        self.0.contains(effect)
    }

    pub fn permits_all(&self, actual: &EffectSet) -> bool {
        actual
            .0
            .iter()
            .all(|effect| self.0.iter().any(|allowed| allowed.permits(effect)))
    }

    pub fn unused_by(&self, actual: &EffectSet) -> Vec<Effect> {
        self.0
            .iter()
            .filter(|allowed| !actual.0.iter().any(|observed| allowed.permits(observed)))
            .cloned()
            .collect()
    }

    pub fn iter(&self) -> impl Iterator<Item = &Effect> {
        self.0.iter()
    }

    /// Models a synchronous `catch` boundary. Other effects are preserved.
    pub fn discharge_throws(&self) -> Self {
        Self(
            self.0
                .iter()
                .filter(|effect| !matches!(effect, Effect::Throw(_)))
                .cloned()
                .collect(),
        )
    }

    fn insert(&mut self, effect: Effect) {
        self.0.insert(effect);
    }
}

/// Backend-independent event IR. `phase` changes at async/concurrent boundaries;
/// ordering within this prototype is the order of events in `EffectTrace`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EffectEvent {
    pub phase: u32,
    pub kind: EffectEventKind,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EffectEventKind {
    Read(Region),
    Mutate(Region),
    Invalidate(Region),
    External(String),
    Suspend {
        invalidates: Vec<Region>,
    },
    Clone(Region),
    Transfer {
        resource: Region,
        target: OwnershipState,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OwnershipState {
    Available,
    Detached,
    Transferred,
    Locked,
    Shared,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OwnershipViolation {
    pub event_index: usize,
    pub resource: Region,
    pub state: OwnershipState,
}

impl EffectEvent {
    pub fn read(phase: u32, region: Region) -> Self {
        Self {
            phase,
            kind: EffectEventKind::Read(region),
        }
    }

    pub fn mutate(phase: u32, region: Region) -> Self {
        Self {
            phase,
            kind: EffectEventKind::Mutate(region),
        }
    }

    pub fn invalidate(phase: u32, region: Region) -> Self {
        Self {
            phase,
            kind: EffectEventKind::Invalidate(region),
        }
    }

    pub fn external(phase: u32, effect: impl Into<String>) -> Self {
        Self {
            phase,
            kind: EffectEventKind::External(effect.into()),
        }
    }

    pub fn suspend(phase: u32, invalidates: Vec<Region>) -> Self {
        Self {
            phase,
            kind: EffectEventKind::Suspend { invalidates },
        }
    }

    pub fn clone_value(phase: u32, resource: Region) -> Self {
        Self {
            phase,
            kind: EffectEventKind::Clone(resource),
        }
    }
    pub fn transfer(phase: u32, resource: Region, target: OwnershipState) -> Self {
        Self {
            phase,
            kind: EffectEventKind::Transfer { resource, target },
        }
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct EffectTrace(Vec<EffectEvent>);

impl EffectTrace {
    pub fn new(events: Vec<EffectEvent>) -> Self {
        Self(events)
    }

    pub fn events(&self) -> &[EffectEvent] {
        &self.0
    }

    /// Erases ordering and temporal events to recover the ordinary may-effect view.
    pub fn may_effects(&self) -> EffectSet {
        let mut effects = EffectSet::default();
        for event in &self.0 {
            match &event.kind {
                EffectEventKind::Mutate(region) => {
                    effects.insert(Effect::Mutate(region.clone()));
                }
                EffectEventKind::External(name) => {
                    effects.insert(Effect::Named(name.clone()));
                }
                EffectEventKind::Read(_)
                | EffectEventKind::Invalidate(_)
                | EffectEventKind::Suspend { .. }
                | EffectEventKind::Clone(_)
                | EffectEventKind::Transfer { .. } => {}
            }
        }
        effects
    }

    /// Checks whether a fact read at `from` remains valid through `to` (inclusive).
    /// Invalid indices conservatively reject reuse.
    pub fn cache_reusable(&self, region: &Region, from: usize, to: usize) -> bool {
        if from >= self.0.len() || to >= self.0.len() || from > to {
            return false;
        }
        self.0[from + 1..=to].iter().all(|event| match &event.kind {
            EffectEventKind::Mutate(changed) | EffectEventKind::Invalidate(changed) => {
                !region.overlaps(changed)
            }
            EffectEventKind::Suspend { invalidates } => {
                invalidates.iter().all(|escaped| !region.overlaps(escaped))
            }
            EffectEventKind::Read(_) | EffectEventKind::External(_) | EffectEventKind::Clone(_) => {
                true
            }
            EffectEventKind::Transfer { resource, .. } => !region.overlaps(resource),
        })
    }

    pub fn ownership_violations(&self) -> Vec<OwnershipViolation> {
        let mut states = BTreeMap::<Region, OwnershipState>::new();
        let mut violations = Vec::new();
        for (event_index, event) in self.0.iter().enumerate() {
            match &event.kind {
                EffectEventKind::Transfer { resource, target } => {
                    let state = states
                        .get(resource)
                        .copied()
                        .unwrap_or(OwnershipState::Available);
                    if state != OwnershipState::Available || *target == OwnershipState::Shared {
                        violations.push(OwnershipViolation {
                            event_index,
                            resource: resource.clone(),
                            state,
                        });
                    } else {
                        states.insert(resource.clone(), *target);
                    }
                }
                EffectEventKind::Read(resource) | EffectEventKind::Mutate(resource) => {
                    let state = states
                        .get(resource)
                        .copied()
                        .unwrap_or(OwnershipState::Available);
                    if !matches!(state, OwnershipState::Available | OwnershipState::Shared) {
                        violations.push(OwnershipViolation {
                            event_index,
                            resource: resource.clone(),
                            state,
                        });
                    }
                }
                EffectEventKind::Clone(_)
                | EffectEventKind::Invalidate(_)
                | EffectEventKind::External(_)
                | EffectEventKind::Suspend { .. } => {}
            }
        }
        violations
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ParseEffectError {
    message: String,
    span: Option<SourceSpan>,
}

impl ParseEffectError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            span: None,
        }
    }

    fn at(mut self, span: SourceSpan) -> Self {
        if self.span.is_none() {
            self.span = Some(span);
        }
        self
    }

    pub fn message(&self) -> &str {
        &self.message
    }

    pub fn span(&self) -> Option<SourceSpan> {
        self.span
    }
}

impl Display for ParseEffectError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

fn invalid_member_start(input: &str) -> usize {
    let mut depth = 0_u32;
    let mut quoted = false;
    let mut member_start = 0;
    for (index, character) in input.char_indices() {
        if character == '"' && !is_escaped(input, index) {
            quoted = !quoted;
            continue;
        }
        if quoted {
            continue;
        }
        match character {
            '<' => depth += 1,
            '>' => depth = depth.saturating_sub(1),
            '|' if depth == 0 => member_start = index + 1,
            _ => {}
        }
    }
    let tail = &input[member_start..];
    member_start + (tail.len() - tail.trim_start().len())
}

impl Error for ParseEffectError {}

fn split_union(input: &str) -> Result<Vec<&str>, ParseEffectError> {
    let mut terms = Vec::new();
    let (mut start, mut depth) = (0, 0_u32);
    let mut quoted = false;
    for (index, character) in input.char_indices() {
        if character == '"' && !is_escaped(input, index) {
            quoted = !quoted;
            continue;
        }
        if quoted {
            continue;
        }
        match character {
            '<' => depth += 1,
            '>' => {
                depth = depth
                    .checked_sub(1)
                    .ok_or_else(|| ParseEffectError::new("unmatched `>`"))?
            }
            '|' if depth == 0 => {
                terms.push(input[start..index].trim());
                start = index + 1;
            }
            _ => {}
        }
    }
    if depth != 0 {
        return Err(ParseEffectError::new("unclosed `<`"));
    }
    if quoted {
        return Err(ParseEffectError::new("unclosed string literal"));
    }
    terms.push(input[start..].trim());
    if terms.iter().any(|term| term.is_empty()) {
        return Err(ParseEffectError::new("empty effect in union"));
    }
    Ok(terms)
}

fn parse_effect(term: &str, schemas: &EffectSchemaRegistry) -> Result<Effect, ParseEffectError> {
    if term == "none" {
        return Err(ParseEffectError::new(
            "`none` denotes an empty effect set, not an effect",
        ));
    }
    if let Some(inner) = term
        .strip_prefix("Mutate<")
        .and_then(|value| value.strip_suffix('>'))
    {
        let region = inner
            .trim()
            .strip_prefix("typeof ")
            .ok_or_else(|| ParseEffectError::new("Mutate requires `typeof <reference>`"))?;
        return Region::new(region).map(Effect::Mutate);
    }
    if let Some(error_type) = term
        .strip_prefix("Throw<")
        .and_then(|value| value.strip_suffix('>'))
    {
        let error_type = error_type.trim();
        if is_type_path(error_type) || error_type == "unknown" {
            return Ok(Effect::Throw(error_type.to_owned()));
        }
        return Err(ParseEffectError::new(format!(
            "invalid thrown error type `{error_type}`"
        )));
    }
    if let Some(open) = term.find('<') {
        let name = term[..open].trim();
        let inner = term[open + 1..]
            .strip_suffix('>')
            .ok_or_else(|| ParseEffectError::new("parameterized effect requires closing `>`"))?;
        if !is_type_path(name) {
            return Err(ParseEffectError::new(format!(
                "invalid effect name `{name}`"
            )));
        }
        let parameters = split_top_level(inner, ',')?;
        let schema = schemas.get(name);
        if let Some(schema) = schema
            && parameters.len() != schema.arguments().len()
        {
            return Err(ParseEffectError::new(format!(
                "capability `{name}` requires {} argument(s)",
                schema.arguments().len()
            )));
        }
        let arguments = parameters
            .iter()
            .enumerate()
            .map(|(index, parameter)| {
                parse_capability_set(
                    schema.and_then(|value| value.arguments().get(index).copied()),
                    parameter,
                )
            })
            .collect::<Result<Vec<_>, _>>()?;
        return Ok(Effect::Capability(Capability {
            name: name.to_owned(),
            arguments,
        }));
    }
    if is_type_path(term) {
        if let Some(schema) = schemas.get(term) {
            Ok(Effect::Capability(Capability {
                name: term.to_owned(),
                arguments: vec![CapabilitySet::All; schema.arguments().len()],
            }))
        } else {
            Ok(Effect::Named(term.to_owned()))
        }
    } else {
        Err(ParseEffectError::new(format!("invalid effect `{term}`")))
    }
}

fn parse_capability_set(
    domain: Option<AtomDomain>,
    input: &str,
) -> Result<CapabilitySet, ParseEffectError> {
    let atoms = split_top_level(input, '|')?
        .into_iter()
        .map(|atom| parse_capability_atom(domain, atom))
        .collect::<Result<BTreeSet<_>, _>>()?;
    Ok(CapabilitySet::Finite(atoms))
}

fn parse_capability_atom(
    domain: Option<AtomDomain>,
    input: &str,
) -> Result<CapabilityAtom, ParseEffectError> {
    let input = input.trim();
    if let Some(region) = input.strip_prefix("typeof ") {
        return Region::new(region.trim()).map(CapabilityAtom::Region);
    }
    if let Some(value) = input
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
    {
        if value.contains('"') || value.contains('\\') {
            return Err(ParseEffectError::new(
                "escaped capability strings are not supported yet",
            ));
        }
        return match domain {
            Some(AtomDomain::Url) => ScopePattern::new(value).map(CapabilityAtom::Url),
            Some(AtomDomain::Path) => PathPattern::new(value).map(CapabilityAtom::Path),
            Some(AtomDomain::Host) => HostPattern::new(value).map(CapabilityAtom::Host),
            Some(AtomDomain::Env) => EnvPattern::new(value).map(CapabilityAtom::Env),
            Some(AtomDomain::Sys) => Err(ParseEffectError::new(
                "Sys descriptors must be unquoted tokens",
            )),
            Some(AtomDomain::Region) => Region::new(value).map(CapabilityAtom::Region),
            Some(AtomDomain::Token) | Some(AtomDomain::Literal) | None => {
                Ok(CapabilityAtom::Literal(value.to_owned()))
            }
        };
    }
    if is_type_path(input) {
        match domain {
            Some(
                AtomDomain::Url
                | AtomDomain::Path
                | AtomDomain::Host
                | AtomDomain::Env
                | AtomDomain::Literal,
            ) => Err(ParseEffectError::new(format!(
                "capability atom `{input}` must be a string literal"
            ))),
            Some(AtomDomain::Region) => Region::new(input).map(CapabilityAtom::Region),
            Some(AtomDomain::Sys) => {
                const SYS: &[&str] = &[
                    "hostname",
                    "osRelease",
                    "osUptime",
                    "loadavg",
                    "networkInterfaces",
                    "systemMemoryInfo",
                    "uid",
                    "gid",
                    "username",
                    "cpus",
                    "homedir",
                ];
                if SYS.contains(&input) {
                    Ok(CapabilityAtom::Sys(input.to_owned()))
                } else {
                    Err(ParseEffectError::new(format!(
                        "unknown Deno Sys descriptor `{input}`"
                    )))
                }
            }
            Some(AtomDomain::Token) | None => Ok(CapabilityAtom::Token(input.to_owned())),
        }
    } else {
        Err(ParseEffectError::new(format!(
            "invalid capability atom `{input}`"
        )))
    }
}

fn split_top_level(input: &str, separator: char) -> Result<Vec<&str>, ParseEffectError> {
    let mut values = Vec::new();
    let (mut start, mut depth) = (0, 0_u32);
    let mut quoted = false;
    for (index, character) in input.char_indices() {
        if character == '"' && !is_escaped(input, index) {
            quoted = !quoted;
            continue;
        }
        if quoted {
            continue;
        }
        match character {
            '<' => depth += 1,
            '>' => {
                depth = depth
                    .checked_sub(1)
                    .ok_or_else(|| ParseEffectError::new("unmatched `>`"))?
            }
            value if value == separator && depth == 0 => {
                values.push(input[start..index].trim());
                start = index + value.len_utf8();
            }
            _ => {}
        }
    }
    if quoted || depth != 0 {
        return Err(ParseEffectError::new("unclosed parameter expression"));
    }
    values.push(input[start..].trim());
    if values.iter().any(|value| value.is_empty()) {
        return Err(ParseEffectError::new("empty parameter"));
    }
    Ok(values)
}

fn is_escaped(input: &str, index: usize) -> bool {
    input[..index]
        .chars()
        .rev()
        .take_while(|character| *character == '\\')
        .count()
        % 2
        == 1
}

fn split_url_scope(value: &str) -> Result<(String, String, Option<String>), ParseEffectError> {
    if value.contains('#') {
        return Err(ParseEffectError::new(
            "URL scope fragments are not supported",
        ));
    }
    let (without_query, query) = value
        .split_once('?')
        .map_or((value, None), |(base, query)| {
            (base, Some(query.to_owned()))
        });
    if query.as_ref().is_some_and(|query| query.contains('*')) {
        return Err(ParseEffectError::new(
            "URL scope query constraints must be exact",
        ));
    }
    let (scheme, remainder) = without_query
        .split_once("://")
        .ok_or_else(|| ParseEffectError::new("URL scope requires an absolute origin"))?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return Err(ParseEffectError::new(format!(
            "unsupported URL scope scheme `{scheme}`"
        )));
    }
    let (authority, path) =
        remainder
            .split_once('/')
            .map_or((remainder, "/"), |(authority, path)| {
                (
                    authority,
                    &without_query[without_query.len() - path.len() - 1..],
                )
            });
    if authority.is_empty()
        || authority.contains('*')
        || authority.contains('@')
        || authority.chars().any(char::is_whitespace)
    {
        return Err(ParseEffectError::new("invalid or wildcard URL authority"));
    }
    let normalized_authority = match (scheme.as_str(), authority.rsplit_once(':')) {
        ("http", Some((host, "80"))) | ("https", Some((host, "443"))) => host,
        _ => authority,
    }
    .to_ascii_lowercase();
    let mut segments = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                segments.pop();
            }
            _ => segments.push(segment),
        }
    }
    let normalized_path = format!("/{}", segments.join("/"));
    Ok((
        format!("{}://{}", scheme, normalized_authority),
        normalized_path,
        query,
    ))
}

fn path_pattern_covers(allowed: &[&str], actual: &[&str]) -> bool {
    if allowed.is_empty() {
        return actual.is_empty();
    }
    if allowed[0] == "**" {
        if allowed.len() == 1 {
            return true;
        }
        return path_pattern_covers(&allowed[1..], actual)
            || (!actual.is_empty()
                && !actual[0].contains('*')
                && path_pattern_covers(allowed, &actual[1..]));
    }
    if actual.is_empty() {
        return false;
    }
    segment_pattern_covers(allowed[0], actual[0])
        && path_pattern_covers(&allowed[1..], &actual[1..])
}

fn segment_pattern_covers(allowed: &str, actual: &str) -> bool {
    if allowed == actual || allowed == "*" {
        return actual != "**";
    }
    if actual.contains('*') {
        return false;
    }
    wildcard_segment_matches(allowed, actual)
}

fn wildcard_segment_matches(pattern: &str, value: &str) -> bool {
    let (pattern, value) = (pattern.as_bytes(), value.as_bytes());
    let mut reachable = vec![false; value.len() + 1];
    reachable[0] = true;
    for token in pattern {
        let mut next = vec![false; value.len() + 1];
        if *token == b'*' {
            for index in 0..=value.len() {
                if reachable[index] {
                    for end in index..=value.len() {
                        next[end] = true;
                    }
                }
            }
        } else {
            for index in 0..value.len() {
                if reachable[index] && value[index] == *token {
                    next[index + 1] = true;
                }
            }
        }
        reachable = next;
    }
    reachable[value.len()]
}

fn is_identifier(value: &str) -> bool {
    let mut chars = value.chars();
    chars.next().is_some_and(is_identifier_start) && chars.all(is_identifier_continue)
}

fn is_identifier_start(character: char) -> bool {
    character == '_' || character == '$' || character.is_ascii_alphabetic()
}

fn is_identifier_continue(character: char) -> bool {
    is_identifier_start(character) || character.is_ascii_digit()
}

fn is_type_path(value: &str) -> bool {
    !value.is_empty() && value.split('.').all(is_identifier)
}

fn is_region_path(value: &str) -> bool {
    if value.is_empty() || value.chars().any(char::is_whitespace) {
        return false;
    }
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len()
        && (bytes[index] == b'_' || bytes[index] == b'$' || bytes[index].is_ascii_alphanumeric())
    {
        index += 1;
    }
    if index == 0 || bytes[0].is_ascii_digit() {
        return false;
    }
    while index < bytes.len() {
        if bytes[index] == b'.' {
            index += 1;
            let start = index;
            while index < bytes.len()
                && (bytes[index] == b'_'
                    || bytes[index] == b'$'
                    || bytes[index].is_ascii_alphanumeric())
            {
                index += 1;
            }
            if start == index || bytes[start].is_ascii_digit() {
                return false;
            }
        } else if bytes[index] == b'[' {
            let Some(close) = value[index + 1..].find(']') else {
                return false;
            };
            if close == 0 {
                return false;
            }
            index += close + 2;
        } else {
            return false;
        }
    }
    true
}
