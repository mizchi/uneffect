/* uneffect:requires enabled */
/* uneffect:ensures result === false */
export function invert(enabled: boolean): boolean {
  return !enabled;
}

/* uneffect:ensures result > 0 */
export function positive(): number {
  return 7;
}
