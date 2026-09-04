/**
 * Minimal package-root contract used by the in-memory verifier host.
 *
 * This file is intentionally self-contained. Re-exporting the implementation
 * graph here lets a virtual consumer file such as `src/numeric.ts` shadow the
 * package's own module with the same path. The verifier only assigns special
 * semantics to these numeric domains, so its compiler host should expose no
 * broader authority than that contract.
 */
declare const intBrand: unique symbol;
declare const natBrand: unique symbol;
declare const floatBrand: unique symbol;
declare const u8Brand: unique symbol;
declare const u32Brand: unique symbol;
declare const i32Brand: unique symbol;
declare const f32Brand: unique symbol;
declare const boundedUint8ArrayBrand: unique symbol;
declare const boundedUint32ArrayBrand: unique symbol;
declare const boundedDataViewBrand: unique symbol;
declare const boundedArrayBufferBrand: unique symbol;
declare const fixedArrayBufferBrand: unique symbol;

export type Int = number & { readonly [intBrand]: "Int" };
export type Nat = Int & { readonly [natBrand]: "Nat" };
export type Float = number & { readonly [floatBrand]: "Float" };
export type U8 = number & { readonly [u8Brand]: "U8" };
export type U32 = number & { readonly [u32Brand]: "U32" };
export type I32 = number & { readonly [i32Brand]: "I32" };
export type F32 = number & { readonly [f32Brand]: "F32" };
export type BoundedUint8Array<MaxLength extends number> = Uint8Array & { readonly [boundedUint8ArrayBrand]: MaxLength };
export type BoundedUint32Array<MaxLength extends number> = Uint32Array & { readonly [boundedUint32ArrayBrand]: MaxLength };
export type BoundedDataView<MaxBytes extends number> = DataView & { readonly [boundedDataViewBrand]: MaxBytes };
export type BoundedArrayBuffer<MaxBytes extends number> = ArrayBuffer & { readonly [boundedArrayBufferBrand]: MaxBytes };
export type FixedArrayBuffer<Bytes extends number> = ArrayBuffer & { readonly [fixedArrayBufferBrand]: Bytes };

export declare const U8_BITS: 8;
export declare const U8_MAX: 255;
export declare const U32_BITS: 32;
export declare const U32_MAX: 4294967295;
export declare const I32_MIN: -2147483648;
export declare const I32_MAX: 2147483647;
export declare const F32_BITS: 32;
