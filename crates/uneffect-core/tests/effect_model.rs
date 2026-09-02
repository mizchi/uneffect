use uneffect_core::{
    AtomDomain, CapabilityAtom, CapabilitySet, Effect, EffectEvent, EffectSchema,
    EffectSchemaRegistry, EffectSet, EffectTrace, EnvPattern, HostPattern, OwnershipState,
    PathAnchor, PathPattern, Region, ScopePattern, SourceSpan, TargetCasePolicy,
    builtin_effect_schema,
};

#[test]
fn parses_none_as_the_explicit_empty_effect_set() {
    let empty = EffectSet::parse("none").unwrap();
    assert!(empty.permits_all(&EffectSet::parse("none").unwrap()));
    assert!(!empty.permits_all(&EffectSet::parse("Console").unwrap()));
    assert!(
        EffectSet::parse("none | Console")
            .unwrap_err()
            .to_string()
            .contains("`none` must be the only member")
    );
}

#[test]
fn located_effect_parse_preserves_corsa_friendly_byte_spans() {
    let input = "Console | Fetch<GET, \"https://example.com/**\">";
    let located = EffectSet::parse_located(input, 7, 100).unwrap();
    assert_eq!(located.effects().len(), 2);
    assert_eq!(located.effects()[0].span(), SourceSpan::new(7, 100, 107));
    assert_eq!(located.effects()[1].span(), SourceSpan::new(7, 110, 146));
    assert!(
        located
            .effect_set()
            .permits_all(&EffectSet::parse("Console").unwrap())
    );
}

#[test]
fn rust_parse_errors_point_at_the_invalid_effect_member() {
    let error = EffectSet::parse_located("Console | Fetch<GET", 3, 20).unwrap_err();
    assert_eq!(error.span(), Some(SourceSpan::new(3, 30, 39)));
}

#[test]
fn builtin_capability_domains_come_from_a_versioned_schema() {
    let fetch = builtin_effect_schema("Fetch").unwrap();
    assert_eq!(fetch.version(), 1);
    assert_eq!(fetch.arguments(), &[AtomDomain::Token, AtomDomain::Url]);

    let fs_read = builtin_effect_schema("FsRead").unwrap();
    assert_eq!(fs_read.arguments(), &[AtomDomain::Path]);
    assert_eq!(
        builtin_effect_schema("ScriptLoad").unwrap().arguments(),
        &[AtomDomain::Token, AtomDomain::Url]
    );
    assert_eq!(
        builtin_effect_schema("ExecuteExternalCode")
            .unwrap()
            .arguments(),
        &[AtomDomain::Url, AtomDomain::Literal]
    );
    assert_eq!(
        builtin_effect_schema("CookieRead").unwrap().arguments(),
        &[AtomDomain::Literal]
    );
    assert_eq!(
        builtin_effect_schema("CookieWrite").unwrap().arguments(),
        &[AtomDomain::Literal]
    );
    assert_eq!(
        builtin_effect_schema("LocalStorageRead")
            .unwrap()
            .arguments(),
        &[AtomDomain::Literal]
    );
    assert_eq!(
        builtin_effect_schema("LocalStorageWrite")
            .unwrap()
            .arguments(),
        &[AtomDomain::Literal]
    );
    assert_eq!(
        builtin_effect_schema("GlobalVarsRead").unwrap().arguments(),
        &[AtomDomain::Literal]
    );
    assert_eq!(
        builtin_effect_schema("GlobalVarsWrite")
            .unwrap()
            .arguments(),
        &[AtomDomain::Literal]
    );
    assert!(builtin_effect_schema("app.Database").is_none());
}

#[test]
fn user_schema_controls_rust_atom_parsing_and_containment() {
    let mut schemas = EffectSchemaRegistry::with_builtins();
    schemas.register(
        "app.Api",
        EffectSchema::new(3, vec![AtomDomain::Token, AtomDomain::Url]),
    );
    let allowed = EffectSet::parse_with_schemas(
        r#"app.Api<READ, "https://api.example.com/v1/**">"#,
        &schemas,
    )
    .unwrap();
    let actual = EffectSet::parse_with_schemas(
        r#"app.Api<READ, "https://api.example.com/v1/users">"#,
        &schemas,
    )
    .unwrap();
    assert!(allowed.permits_all(&actual));
    assert_eq!(schemas.get("app.Api").unwrap().version(), 3);
}

#[test]
fn deno_host_scopes_support_subdomain_wildcards_and_optional_ports() {
    let all_ports = HostPattern::new("*.example.com").unwrap();
    let exact = HostPattern::new("api.example.com:443").unwrap();
    let root = HostPattern::new("example.com:443").unwrap();
    assert!(all_ports.covers(&exact));
    assert!(!all_ports.covers(&root));

    let https_only = EffectSet::parse(r#"Net<"*.example.com:443">"#).unwrap();
    assert!(https_only.permits_all(&EffectSet::parse(r#"Net<"api.example.com:443">"#).unwrap()));
    assert!(!https_only.permits_all(&EffectSet::parse(r#"Net<"api.example.com:80">"#).unwrap()));
}

#[test]
fn deno_environment_scopes_support_only_suffix_wildcards() {
    let allowed = EffectSet::parse(r#"Env<"AWS_*">"#).unwrap();
    assert!(allowed.permits_all(&EffectSet::parse(r#"Env<"AWS_REGION">"#).unwrap()));
    assert!(!allowed.permits_all(&EffectSet::parse(r#"Env<"HOME">"#).unwrap()));
    assert!(EffectSet::parse(r#"Env<"*SECRET">"#).is_err());
}

#[test]
fn target_policy_handles_windows_env_case_and_cross_anchor_paths() {
    let env = EnvPattern::new("path").unwrap();
    let actual_env = EnvPattern::new("PATH").unwrap();
    assert!(env.covers_with_policy(&actual_env, TargetCasePolicy::Insensitive));
    assert!(!env.covers_with_policy(&actual_env, TargetCasePolicy::Sensitive));

    let allowed = PathPattern::new("$WORKSPACE_ROOT/src/**").unwrap();
    let actual = PathPattern::new("$CWD/SRC/file.ts").unwrap();
    let bindings = [
        (PathAnchor::WorkspaceRoot, "C:/Repo".to_owned()),
        (PathAnchor::Cwd, "c:/repo".to_owned()),
    ]
    .into_iter()
    .collect();
    assert!(allowed.covers_with_bindings(&actual, &bindings, TargetCasePolicy::Insensitive));
}

#[test]
fn sys_rejects_unknown_deno_permission_descriptors() {
    assert!(EffectSet::parse("Sys<hostname | cpus>").is_ok());
    assert!(EffectSet::parse("Sys<launchMissiles>").is_err());
}

#[test]
fn parses_typescript_friendly_effect_union() {
    let effects = EffectSet::parse("FsRead | FsWrite | Mutate<typeof value>").unwrap();
    assert!(effects.iter().any(|effect| matches!(
        effect,
        Effect::Capability(capability)
            if capability.name() == "FsRead"
                && capability.arguments() == &[CapabilitySet::All]
    )));
    assert!(effects.iter().any(|effect| matches!(
        effect,
        Effect::Capability(capability)
            if capability.name() == "FsWrite"
                && capability.arguments() == &[CapabilitySet::All]
    )));
    assert!(effects.contains(&Effect::Mutate(Region::new("value").unwrap())));
}

#[test]
fn broad_mutation_region_permits_member_mutation() {
    let allowed = EffectSet::parse("Mutate<typeof state>").unwrap();
    let actual = EffectSet::parse("Mutate<typeof state.current>").unwrap();
    assert!(allowed.permits_all(&actual));
}

#[test]
fn sibling_mutation_is_not_permitted() {
    let allowed = EffectSet::parse("Mutate<typeof left>").unwrap();
    let actual = EffectSet::parse("Mutate<typeof right>").unwrap();
    assert!(!allowed.permits_all(&actual));
}

#[test]
fn reports_only_unused_upper_bound_effects() {
    let allowed = EffectSet::parse("Console | Fetch | Mutate<typeof state>").unwrap();
    let actual = EffectSet::parse("Console | Mutate<typeof state.child>").unwrap();
    let expected = EffectSet::parse("Fetch").unwrap();
    assert_eq!(
        allowed.unused_by(&actual),
        expected.iter().cloned().collect::<Vec<_>>(),
    );
}

#[test]
fn substitutes_parameter_region_with_argument_region() {
    let effect = Effect::Mutate(Region::new("value.items").unwrap());
    assert_eq!(
        effect.substitute_region("value", "state.current"),
        Effect::Mutate(Region::new("state.current.items").unwrap()),
    );
}

#[test]
fn rejects_arbitrary_typescript_in_mutation_region() {
    assert!(EffectSet::parse("Mutate<typeof (a | b)>").is_err());
    assert!(EffectSet::parse("Mutate<Foo>").is_err());
}

#[test]
fn parses_typed_throw_effect() {
    let effects = EffectSet::parse("Throw<RangeError> | Console").unwrap();
    assert!(effects.contains(&Effect::Throw("RangeError".into())));
}

#[test]
fn broad_error_throw_permits_concrete_error_throw() {
    let allowed = EffectSet::parse("Throw<Error>").unwrap();
    let actual = EffectSet::parse("Throw<TypeError>").unwrap();
    assert!(allowed.permits_all(&actual));
}

#[test]
fn error_throw_does_not_permit_unknown_javascript_throw() {
    let allowed = EffectSet::parse("Throw<Error>").unwrap();
    let actual = EffectSet::parse("Throw<unknown>").unwrap();
    assert!(!allowed.permits_all(&actual));
}

#[test]
fn catch_discharges_all_synchronous_throw_effects_only() {
    let effects = EffectSet::parse("Throw<RangeError> | Throw<unknown> | Console").unwrap();
    let discharged = effects.discharge_throws();
    assert_eq!(
        discharged.iter().cloned().collect::<Vec<_>>(),
        vec![Effect::Named("Console".into())]
    );
}

#[test]
fn neutral_ir_projects_ordered_events_to_a_may_effect_set() {
    let state = Region::new("state.current").unwrap();
    let trace = EffectTrace::new(vec![
        EffectEvent::external(0, "Fetch"),
        EffectEvent::mutate(0, state.clone()),
        EffectEvent::suspend(1, vec![state]),
    ]);

    let effects = trace.may_effects();
    assert!(effects.contains(&Effect::Named("Fetch".into())));
    assert!(effects.contains(&Effect::Mutate(Region::new("state.current").unwrap())));
}

#[test]
fn mutation_invalidates_cached_facts_for_overlapping_regions_only() {
    let cached = Region::new("state.user").unwrap();
    let trace = EffectTrace::new(vec![
        EffectEvent::read(0, cached.clone()),
        EffectEvent::mutate(0, Region::new("state.settings.theme").unwrap()),
        EffectEvent::mutate(0, Region::new("state.user.name").unwrap()),
    ]);

    assert!(trace.cache_reusable(&cached, 0, 1));
    assert!(!trace.cache_reusable(&cached, 0, 2));
}

#[test]
fn suspension_invalidates_only_regions_that_may_escape() {
    let shared = Region::new("shared").unwrap();
    let local = Region::new("local").unwrap();
    let trace = EffectTrace::new(vec![
        EffectEvent::read(0, shared.clone()),
        EffectEvent::read(0, local.clone()),
        EffectEvent::suspend(1, vec![shared.clone()]),
    ]);

    assert!(!trace.cache_reusable(&shared, 0, 2));
    assert!(trace.cache_reusable(&local, 1, 2));
}

#[test]
fn parses_parameterized_fetch_without_splitting_nested_unions() {
    let effects =
        EffectSet::parse(r#"Console | Fetch<GET | POST, "https://api.example.com/v1/**">"#)
            .unwrap();
    let fetch = effects
        .iter()
        .find_map(|effect| match effect {
            Effect::Capability(scoped) => Some(scoped),
            _ => None,
        })
        .unwrap();
    assert_eq!(fetch.name(), "Fetch");
    assert_eq!(
        fetch.arguments(),
        &[
            CapabilitySet::Finite(
                [
                    CapabilityAtom::Token("GET".into()),
                    CapabilityAtom::Token("POST".into()),
                ]
                .into()
            ),
            CapabilitySet::Finite(
                [CapabilityAtom::Url(
                    ScopePattern::new("https://api.example.com/v1/**").unwrap()
                ),]
                .into()
            ),
        ]
    );
}

#[test]
fn scoped_fetch_permits_narrower_methods_and_exact_urls() {
    let allowed =
        EffectSet::parse(r#"Fetch<GET | POST, "https://api.example.com/v1/**">"#).unwrap();
    let actual = EffectSet::parse(r#"Fetch<GET, "https://api.example.com/v1/users/1">"#).unwrap();
    assert!(allowed.permits_all(&actual));
}

#[test]
fn scoped_fetch_rejects_unlisted_methods_and_origins() {
    let allowed = EffectSet::parse(r#"Fetch<GET, "https://api.example.com/v1/**">"#).unwrap();
    let post = EffectSet::parse(r#"Fetch<POST, "https://api.example.com/v1/users">"#).unwrap();
    let other_origin = EffectSet::parse(r#"Fetch<GET, "https://evil.example/v1/users">"#).unwrap();
    assert!(!allowed.permits_all(&post));
    assert!(!allowed.permits_all(&other_origin));
}

#[test]
fn glob_scope_inclusion_is_conservative_and_segment_aware() {
    let broad = ScopePattern::new("https://api.example.com/v1/**").unwrap();
    let narrow = ScopePattern::new("https://api.example.com/v1/users/*").unwrap();
    let too_broad = ScopePattern::new("https://api.example.com/**").unwrap();
    assert!(broad.covers(&narrow));
    assert!(!narrow.covers(&broad));
    assert!(!broad.covers(&too_broad));
}

#[test]
fn url_scope_rejects_wildcard_origins() {
    assert!(ScopePattern::new("https://*.example.com/**").is_err());
    assert!(ScopePattern::new("*://example.com/**").is_err());
}

#[test]
fn url_scope_normalizes_dot_segments_and_uses_exact_or_unconstrained_queries() {
    let normalized =
        ScopePattern::new("HTTPS://API.EXAMPLE.COM:443/a/../v1/users?role=admin").unwrap();
    assert_eq!(
        normalized.as_str(),
        "https://api.example.com/v1/users?role=admin"
    );
    let exact = ScopePattern::new("https://api.example.com/v1/**?role=admin").unwrap();
    let same = ScopePattern::new("https://api.example.com/v1/users?role=admin").unwrap();
    let other = ScopePattern::new("https://api.example.com/v1/users?role=user").unwrap();
    let unconstrained = ScopePattern::new("https://api.example.com/v1/**").unwrap();
    assert!(exact.covers(&same));
    assert!(!exact.covers(&other));
    assert!(unconstrained.covers(&other));
}

#[test]
fn all_and_finite_sets_are_shared_by_deno_style_capabilities() {
    let all = EffectSet::parse("FsRead").unwrap();
    let temp = EffectSet::parse(r#"FsRead<"$TEMP/**">"#).unwrap();
    let workspace = EffectSet::parse(r#"FsRead<"$WORKSPACE_ROOT/**">"#).unwrap();
    assert!(all.permits_all(&temp));
    assert!(!temp.permits_all(&workspace));
}

#[test]
fn generic_capability_arguments_use_the_same_finite_set_lattice() {
    let allowed = EffectSet::parse(r#"app.Database<SELECT | UPDATE, "users" | "posts">"#).unwrap();
    let actual = EffectSet::parse(r#"app.Database<SELECT, "users">"#).unwrap();
    let denied = EffectSet::parse(r#"app.Database<DELETE, "users">"#).unwrap();
    assert!(allowed.permits_all(&actual));
    assert!(!allowed.permits_all(&denied));
}

#[test]
fn symbolic_temp_path_covers_descendants_but_not_other_anchors() {
    let temp = PathPattern::new("$TEMP/**").unwrap();
    let nested = PathPattern::new("$TEMP/uneffect/cache/file.bin").unwrap();
    let workspace = PathPattern::new("$WORKSPACE_ROOT/cache/file.bin").unwrap();
    assert!(temp.covers(&nested));
    assert!(!temp.covers(&workspace));
}

#[test]
fn filesystem_capabilities_use_symbolic_path_containment() {
    let allowed = EffectSet::parse(r#"FsWrite<"$TEMP/**">"#).unwrap();
    let actual = EffectSet::parse(r#"FsWrite<"$TEMP/uneffect/result.json">"#).unwrap();
    let escaped = EffectSet::parse(r#"FsWrite<"$WORKSPACE_ROOT/result.json">"#).unwrap();
    assert!(allowed.permits_all(&actual));
    assert!(!allowed.permits_all(&escaped));
}

#[test]
fn path_patterns_reject_unknown_anchors_and_parent_traversal() {
    assert!(PathPattern::new("$HOME/secrets").is_err());
    assert!(PathPattern::new("$TEMP/../secrets").is_err());
}

#[test]
fn neutral_ir_rejects_use_and_second_transfer_after_detach_but_clone_preserves() {
    let buffer = Region::new("buffer").unwrap();
    let trace = EffectTrace::new(vec![
        EffectEvent::clone_value(0, buffer.clone()),
        EffectEvent::transfer(0, buffer.clone(), OwnershipState::Detached),
        EffectEvent::read(0, buffer.clone()),
        EffectEvent::transfer(0, buffer, OwnershipState::Detached),
    ]);
    assert_eq!(trace.ownership_violations().len(), 2);
}
