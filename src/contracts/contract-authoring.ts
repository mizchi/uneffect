import type { TemporalType } from "../spec/temporal-authoring.js";

type ValueOf<Type> = Type extends TemporalType<infer Value> ? Value : never;
type ParameterShape = Readonly<Record<string, TemporalType<unknown>>>;
type ParametersOf<Shape extends ParameterShape> = { readonly [Name in keyof Shape]: ValueOf<Shape[Name]> };
type ContractPredicate<Value> = (values: Value) => boolean;
export interface ContractDefinition<Parameters extends ParameterShape, Result extends TemporalType<unknown>> {
  readonly parameters: Parameters;
  readonly returns: Result;
  readonly requires?: ContractPredicate<ParametersOf<Parameters>> | readonly ContractPredicate<ParametersOf<Parameters>>[];
  readonly ensures: ContractPredicate<ParametersOf<Parameters> & { readonly result: ValueOf<Result> }> | readonly ContractPredicate<ParametersOf<Parameters> & { readonly result: ValueOf<Result> }>[];
}
export const defineContract = <const Parameters extends ParameterShape, const Result extends TemporalType<unknown>>(definition: ContractDefinition<Parameters, Result>): ContractDefinition<Parameters, Result> => definition;
export const nat = (): TemporalType<number> => ({ kind: "nat" }) as TemporalType<number>;
export const float = (): TemporalType<number> => ({ kind: "float" }) as TemporalType<number>;
