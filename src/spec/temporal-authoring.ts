declare const temporalDescriptor: unique symbol;
export interface TemporalType<Value> { readonly [temporalDescriptor]: Value; readonly kind: "int" | "nat" | "float" | "bool" | "string" }
export const int = (): TemporalType<number> => ({ kind: "int" }) as TemporalType<number>;
export const bool = (): TemporalType<boolean> => ({ kind: "bool" }) as TemporalType<boolean>;
export const text = (): TemporalType<string> => ({ kind: "string" }) as TemporalType<string>;

type StateShape = Readonly<Record<string, TemporalType<unknown>>>;
type StateOf<Shape extends StateShape> = { -readonly [Key in keyof Shape]: Shape[Key] extends TemporalType<infer Value> ? Value : never };
type Predicate<State> = (state: Readonly<State>) => boolean;
type Update<State> = (state: Readonly<State>) => Partial<State>;
export interface TemporalDefinition<Shape extends StateShape, Actions extends Readonly<Record<string, Update<StateOf<Shape>>>>> {
  readonly state: Shape;
  readonly init: StateOf<Shape>;
  readonly actions: Actions;
  readonly guards?: Partial<{ readonly [Name in keyof Actions]: Predicate<StateOf<Shape>> }>;
  readonly fairness?: Partial<{ readonly [Name in keyof Actions]: "weak" | "strong" }>;
  readonly invariants?: Readonly<Record<string, Predicate<StateOf<Shape>>>>;
  readonly eventually?: Readonly<Record<string, Predicate<StateOf<Shape>>>>;
  readonly repeatedly?: Readonly<Record<string, Predicate<StateOf<Shape>>>>;
  readonly stabilizes?: Readonly<Record<string, Predicate<StateOf<Shape>>>>;
  readonly responses?: Readonly<Record<string, { readonly trigger: Predicate<StateOf<Shape>>; readonly response: Predicate<StateOf<Shape>> }>>;
}

/** Type-level authoring helper. Uneffect reads its AST and never executes the module. */
export const defineTemporal = <const Shape extends StateShape, const Actions extends Readonly<Record<string, Update<StateOf<Shape>>>>>(definition: TemporalDefinition<Shape, Actions>): TemporalDefinition<Shape, Actions> => definition;
