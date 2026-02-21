import { ok } from "assert";

export function getPlaceholder() {
  return Math.random().toString(36).substring(2, 15);
}

export function choice<T>(elements: T[]): T {
  ok(elements.length > 0, "choice() called on empty sequence");
  return elements[Math.floor(Math.random() * elements.length)];
}

export function getRandom(): number {
  return Math.random();
}

export function getRandomInt(min: number, max: number): number {
  ok(min <= max, "min must be <= max");
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Shuffles an array in-place using the Fisher-Yates algorithm.
 * @param array - The array to shuffle (mutated)
 */
export function shuffle<T>(array: T[]): T[] {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}
