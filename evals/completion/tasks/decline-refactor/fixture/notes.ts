export const notes: string[] = [];

// ts-prune-ignore-next
export function addNote(note: string): void {
  notes.push(note);
}
