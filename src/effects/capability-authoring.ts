import type { AtomDomain } from "./capabilities.js";

declare const capabilityDescriptor: unique symbol;
export interface CapabilityDescriptor { readonly [capabilityDescriptor]: true }
export interface CapabilityDefinition { readonly effects: readonly CapabilityDescriptor[] }
export const defineCapability = <const Definition extends CapabilityDefinition>(definition: Definition): Definition => definition;
export const Console = (): CapabilityDescriptor => ({}) as CapabilityDescriptor;
export const Fetch = (_scope: { readonly methods: readonly ("GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS")[]; readonly urls: readonly string[] }): CapabilityDescriptor => ({}) as CapabilityDescriptor;
export const FsRead = (_scope: { readonly paths: readonly string[] }): CapabilityDescriptor => ({}) as CapabilityDescriptor;
export const FsWrite = (_scope: { readonly paths: readonly string[] }): CapabilityDescriptor => ({}) as CapabilityDescriptor;
export const Throw = (_error: ErrorConstructor): CapabilityDescriptor => ({}) as CapabilityDescriptor;
export type BuiltinEffectName =
  | "Console" | "Storage" | "Random" | "Timer" | "InvokeUserCode"
  | "CookieRead" | "CookieWrite" | "LocalStorageRead" | "LocalStorageWrite"
  | "GlobalVarsRead" | "GlobalVarsWrite"
  | "ScriptLoad" | "ExecuteExternalCode" | "Fetch" | "Dom" | "Clone" | "Transfer" | "SharedMemory"
  | "FsRead" | "FsWrite" | "Ffi" | "Net" | "Env" | "Run" | "Sys" | "Import";
export const Builtin = (_name: BuiltinEffectName, _scope?: { readonly arguments: readonly (readonly string[] | "All")[] }): CapabilityDescriptor => ({}) as CapabilityDescriptor;
export interface LocalEffectSchema<Name extends string = string> { readonly name: Name; readonly version: 1; readonly arguments: readonly AtomDomain[] }
export const defineEffectSchema = <const Name extends string, const Domains extends readonly AtomDomain[]>(schema: { readonly name: Name; readonly version?: 1; readonly arguments: Domains }): LocalEffectSchema<Name> => ({ ...schema, version: 1 });
export const Custom = (_schema: LocalEffectSchema, _scope?: { readonly arguments: readonly (readonly string[] | "All")[] }): CapabilityDescriptor => ({}) as CapabilityDescriptor;
