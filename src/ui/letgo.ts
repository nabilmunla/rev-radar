// 0.6.0 T22 B (DECISIONS 106): does the view engine that makes ready let go of what it holds (and so start afresh)?
// Only when it is not the one on screen, it says it is past a memory bar, and the sheet that took it there is not among
// the pairs it will still keep once `nextId` is open. (No imports: unit-tested as it is.)
export function mustLetGo(o: { onScreen: boolean; past?: boolean; grewMost?: string | null; held: string[]; nextId: string; keep: number }): boolean {
  if (o.onScreen || !o.past) return false;
  const kept = [...o.held.filter((id) => id !== o.nextId), o.nextId].slice(-Math.max(1, o.keep));
  return !(o.grewMost && kept.includes(o.grewMost));
}
