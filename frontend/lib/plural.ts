// "1 day" / "2 days", "1 person" / "5 people": one place, so a count of one never reads as "1 days" or "1 people".
export function plural(n: number, one: string, many: string = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Only the word, for screens that style the number and the word separately. */
export const unit = (n: number, one: string, many: string = `${one}s`): string => (n === 1 ? one : many);
