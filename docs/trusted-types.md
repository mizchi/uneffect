# Trusted Types

Uneffect includes an experimental, fail-closed checker for the [`TrustedScript` portion of the W3C Trusted Types specification](https://w3c.github.io/trusted-types/dist/spec/#trusted-script).

The checker follows value provenance rather than trusting a structural TypeScript type. A cast such as `input as TrustedScript` is rejected. The currently accepted producers are:

```ts
const policy = trustedTypes.createPolicy("app", {
  createScript(input) {
    if (input === "boot()") return input;
    throw new TypeError("rejected script");
  },
});

const boot = policy.createScript("boot()");
eval(boot);                         // accepted
setTimeout(trustedTypes.emptyScript, 0); // accepted
```

Current checked sinks are:

- direct global `eval`;
- string forms of global `setTimeout` and `setInterval`; callable handlers are not script-string sinks;
- direct global `Function(...)` and `new Function(...)`, using the body argument;
- `HTMLScriptElement.innerText`, `.text`, and `.textContent` assignments when the receiver is proven from `document.createElement("script")` or the platform `HTMLScriptElement` identity.

Plain strings, type assertions, mutable/unresolved aliases, same-shaped local policy objects, and shadowed `trustedTypes` factories are not accepted as TrustedScript evidence.

## Assurance boundary

This is not a CSP deployment check and does not prove that `require-trusted-types-for 'script'` is present in the delivered HTTP response. It also does not prove that a `createScript` policy implementation is a correct sanitizer or allowlist. The policy is a security-critical trusted boundary that must be reviewed independently.

The current fragment does not yet cover indirect eval, async/generator function constructors, script text-node insertion, SVG script text, event-handler attributes, Web Worker variants, default-policy behavior, cross-file policy flow, or runtime `trustedTypes.isScript` narrowing. `TrustedHTML` and `TrustedScriptURL` have separate sink semantics and are not claimed by this checker.

