import type { Cursor } from '../math/model';

/** Caret position: block index, offset in "units" (chars, each inline equation = 1), optional cursor inside an equation. */
export interface Pos {
  b: number;
  off: number;
  math?: Cursor;
}

interface State {
  md: string;
  pos: Pos | null;
}

export type ChangeKind = 'text' | 'math' | 'struct';

/** Snapshot undo: every state is the full markdown, which is cheap for notes-sized documents. */
export class History {
  private states: State[] = [];
  private i = -1;
  private lastKind: ChangeKind | null = null;
  private lastAt = 0;

  reset(md: string, pos: Pos | null) {
    this.states = [{ md, pos }];
    this.i = 0;
    this.lastKind = null;
  }

  record(md: string, pos: Pos | null, kind: ChangeKind) {
    const top = this.states[this.i];
    const now = Date.now();
    if (top && top.md === md) {
      top.pos = pos;
      return;
    }
    this.states.length = this.i + 1;
    const coalesce = kind !== 'struct' && kind === this.lastKind && now - this.lastAt < 1000 && this.i > 0;
    if (coalesce) this.states[this.i] = { md, pos };
    else this.states[++this.i] = { md, pos };
    this.lastKind = kind;
    this.lastAt = now;
  }

  undo(): State | null {
    if (this.i <= 0) return null;
    this.lastKind = null;
    return this.states[--this.i];
  }

  redo(): State | null {
    if (this.i >= this.states.length - 1) return null;
    this.lastKind = null;
    return this.states[++this.i];
  }
}
