export function amountsMatch(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.01;
}

export function combinations<T>(array: T[]): T[][] {
  return new Array((1 << array.length) - 1).fill(null).map((e1, i) => array.filter((e2, j) => (i + 1) & (1 << j)));
}

export function getTotalAmount(items: { amount: number }[]): number {
  return Number(items.reduce((amount, item) => amount + item.amount, 0).toFixed(2));
}
