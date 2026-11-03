import type { NoteDto, NoteInputDto } from "@repolens/core/types";
import { useEffect } from "react";
import { create } from "zustand";
import { api } from "../api/client";
import { useAppStore } from "./useAppStore";

interface NotesState {
  notes: NoteDto[];
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  /** Increment when pressing N: the input box in the note tab gets focus accordingly */
  composeRequest: number;
  load: () => Promise<void>;
  add: (input: NoteInputDto) => Promise<NoteDto>;
  remove: (id: string) => Promise<void>;
}

/** Increment when switching repositories, so that requests from the old repository still in transit are no longer written back after landing */
let generation = 0;

export const useNotesStore = create<NotesState>((set) => ({
  notes: [],
  status: "idle",
  error: null,
  composeRequest: 0,

  async load() {
    const current = generation;
    set({ status: "loading", error: null });
    try {
      const { notes } = await api.notes();
      if (current === generation) set({ notes, status: "ready" });
    } catch (err) {
      if (current === generation) set({ status: "error", error: (err as Error).message });
    }
  },

  async add(input) {
    const current = generation;
    const note = await api.addNote(input);
    if (current === generation) set((state) => ({ notes: [...state.notes, note] }));
    return note;
  },

  async remove(id) {
    const current = generation;
    await api.deleteNote(id);
    if (current === generation) set((state) => ({ notes: state.notes.filter((note) => note.id !== id) }));
  },
}));

// After rescanning, the file ID will change, and the nodeId converted in the notes also needs to be retrieved again.
useAppStore.subscribe((state, previous) => {
  if (state.repoId !== previous.repoId || state.repoRevision !== previous.repoRevision) {
    generation++;
    useNotesStore.setState({ notes: [], status: "idle", error: null });
  }
});

/** Only pick it up the first time it is used or after changing the warehouse */
export function useNotes(): NoteDto[] {
  const notes = useNotesStore((s) => s.notes);
  const status = useNotesStore((s) => s.status);
  useEffect(() => {
    if (status === "idle") void useNotesStore.getState().load();
  }, [status]);
  return notes;
}

export function notesOnFile(notes: NoteDto[], path: string): NoteDto[] {
  return notes.filter((note) => note.target.kind === "file" && note.target.path === path);
}

/** Notes whose line numbers intersect with [from, to]; notes covering the entire file without line numbers do not count */
export function notesInRange(notes: NoteDto[], path: string, from: number, to: number): NoteDto[] {
  return notes.filter((note) => {
    const lines = note.target.kind === "file" && note.target.path === path ? note.target.lines : null;
    return lines !== null && lines[0] <= to && lines[1] >= from;
  });
}

/** Notes attached to this directory or package; the directory also includes notes from the files under it */
export function notesOnScope(notes: NoteDto[], scopeId: string): NoteDto[] {
  const dir = scopeId.startsWith("dir:") ? scopeId.slice(4) : null;
  return notes.filter((note) => {
    if (note.target.kind === "scope") return note.target.id === scopeId;
    if (dir === null) return false;
    return dir === "." || note.target.path.startsWith(`${dir}/`);
  });
}

export function formatLines(lines: [number, number]): string {
  return lines[0] === lines[1] ? `L${lines[0]}` : `L${lines[0]}–${lines[1]}`;
}

/** Jot a note: Open the notes tab for the selected node (if none is selected, it's the entire repository), and focus on the input box. */
export function composeNote(): void {
  const { selected, openDetail, rootScope } = useAppStore.getState();
  const target = selected !== null && /^(?:pkg|dir|file|sym):./.test(selected) ? selected : rootScope;
  openDetail(target, { tab: "notes", lines: null }, false);
  useNotesStore.setState((state) => ({ composeRequest: state.composeRequest + 1 }));
}

/** Jump to the location of the note: if there is a line number, open the source code and navigate to it; otherwise, open the note tab in the details. */
export function openNote(note: NoteDto): void {
  if (note.nodeId === null) return;
  const lines = note.target.kind === "file" ? note.target.lines : null;
  useAppStore.getState().openDetail(note.nodeId, lines ? { tab: "source", lines } : { tab: "notes", lines: null });
}
