/** Single Zustand store, persisted through MMKV (AsyncStorage fallback).
 *
 *  Persisted: assignments, results, settings, and the pending-scan pipeline.
 *  Pending scans persist on purpose — a stack captured on a bad connection
 *  should still be waiting after a restart. */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { zustandStorage } from '@/lib/storage';
import { uuidv4 } from '@/lib/id';
import { setHapticsEnabled } from '@/lib/haptics';
import { computeTotals, cycleOverride } from '@/lib/scoring';
import type {
  AnswerKey,
  Assignment,
  PendingScan,
  PendingStatus,
  ScanResult,
  ScoredProblem,
  Settings,
} from '@/types';

export const DEFAULT_SETTINGS: Settings = {
  partialCredit: false,
  autoCapture: true,
  scanEngine: 'vision',
  uploadImages: false,
  hapticsEnabled: true,
  confidenceFloor: 0.6,
};

const DEFAULT_KEY: AnswerKey = { mode: 'ai', updatedAt: 0 };

/** "Sep 29" style default so a teacher can scan without naming anything,
 *  then rename later from the summary screen. */
export function defaultAssignmentName(date = new Date()): string {
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

interface State {
  hydrated: boolean;
  settings: Settings;

  assignments: Assignment[];
  currentAssignmentId: string | null;

  /** Keyed by assignment id, newest first. */
  resultsByAssignment: Record<string, ScanResult[]>;

  /** Captures working their way through the background grader, oldest first. */
  pending: PendingScan[];

  /** True until the first-launch tooltip has been dismissed. */
  showFirstRunTip: boolean;
}

interface Actions {
  markHydrated(): void;

  updateSettings(patch: Partial<Settings>): void;
  dismissFirstRunTip(): void;

  ensureAssignment(): Assignment;
  currentAssignment(): Assignment | null;
  startNewAssignment(name?: string): Assignment;
  renameAssignment(id: string, name: string): void;
  selectAssignment(id: string): void;
  deleteAssignment(id: string): void;

  setAnswerKey(key: AnswerKey): void;

  /** Adds a graded paper. An empty `studentName` is filled in with the next
   *  "Student N" here rather than by the caller, so two grades landing at the
   *  same time cannot be handed the same label. */
  addResult(result: Omit<ScanResult, 'studentName'> & { studentName: string }): void;
  updateResult(assignmentId: string, resultId: string, patch: Partial<ScanResult>): void;
  deleteResult(assignmentId: string, resultId: string): void;
  toggleProblemOverride(assignmentId: string, resultId: string, problemIndex: number): void;
  resultsFor(assignmentId: string): ScanResult[];
  getResult(assignmentId: string, resultId: string): ScanResult | null;

  addPending(scan: PendingScan): void;
  updatePending(id: string, patch: Partial<PendingScan>): void;
  setPendingStatus(id: string, status: PendingStatus): void;
  removePending(id: string): void;
  getPending(id: string): PendingScan | null;
  /** Put a failed scan back in line for another try. */
  retryPending(id: string): void;
  clearFailedPending(): void;
}

export type Store = State & Actions;

export const useStore = create<Store>()(
  persist(
    (set, get) => ({
      hydrated: false,
      settings: DEFAULT_SETTINGS,
      assignments: [],
      currentAssignmentId: null,
      resultsByAssignment: {},
      pending: [],
      showFirstRunTip: true,

      markHydrated: () => set({ hydrated: true }),

      updateSettings: (patch) =>
        set((s) => {
          const settings = { ...s.settings, ...patch };
          setHapticsEnabled(settings.hapticsEnabled);
          return { settings };
        }),

      dismissFirstRunTip: () => set({ showFirstRunTip: false }),

      /** Lazily create the first assignment so the camera never waits on setup. */
      ensureAssignment: () => get().currentAssignment() ?? get().startNewAssignment(),

      currentAssignment: () => {
        const { assignments, currentAssignmentId } = get();
        return assignments.find((a) => a.id === currentAssignmentId) ?? null;
      },

      startNewAssignment: (name) => {
        // Carry the active answer key forward: scanning a second class on the
        // same worksheet should not mean re-entering the key.
        const previousKey = get().currentAssignment()?.answerKey ?? DEFAULT_KEY;
        const assignment: Assignment = {
          id: uuidv4(),
          name: name?.trim() || defaultAssignmentName(),
          createdAt: Date.now(),
          answerKey: previousKey,
        };
        set((s) => ({
          assignments: [assignment, ...s.assignments],
          currentAssignmentId: assignment.id,
          resultsByAssignment: { ...s.resultsByAssignment, [assignment.id]: [] },
        }));
        return assignment;
      },

      renameAssignment: (id, name) =>
        set((s) => ({
          assignments: s.assignments.map((a) =>
            a.id === id ? { ...a, name: name.trim() || a.name } : a,
          ),
        })),

      selectAssignment: (id) => set({ currentAssignmentId: id }),

      deleteAssignment: (id) =>
        set((s) => {
          const assignments = s.assignments.filter((a) => a.id !== id);
          const { [id]: _removed, ...rest } = s.resultsByAssignment;
          return {
            assignments,
            resultsByAssignment: rest,
            pending: s.pending.filter((p) => p.assignmentId !== id),
            currentAssignmentId:
              s.currentAssignmentId === id ? (assignments[0]?.id ?? null) : s.currentAssignmentId,
          };
        }),

      setAnswerKey: (key) =>
        set((s) => {
          const id = s.currentAssignmentId;
          if (!id) return s;
          return {
            assignments: s.assignments.map((a) =>
              a.id === id ? { ...a, answerKey: { ...key, updatedAt: Date.now() } } : a,
            ),
          };
        }),

      addResult: (result) =>
        set((s) => {
          const list = s.resultsByAssignment[result.assignmentId] ?? [];
          const named: ScanResult = result.studentName
            ? result
            : { ...result, studentName: `Student ${list.length + 1}` };
          return {
            resultsByAssignment: {
              ...s.resultsByAssignment,
              [result.assignmentId]: [named, ...list],
            },
          };
        }),

      updateResult: (assignmentId, resultId, patch) =>
        set((s) => {
          const list = s.resultsByAssignment[assignmentId];
          if (!list) return s;
          return {
            resultsByAssignment: {
              ...s.resultsByAssignment,
              [assignmentId]: list.map((r) => (r.id === resultId ? { ...r, ...patch } : r)),
            },
          };
        }),

      deleteResult: (assignmentId, resultId) =>
        set((s) => {
          const list = s.resultsByAssignment[assignmentId];
          if (!list) return s;
          return {
            resultsByAssignment: {
              ...s.resultsByAssignment,
              [assignmentId]: list.filter((r) => r.id !== resultId),
            },
          };
        }),

      toggleProblemOverride: (assignmentId, resultId, problemIndex) =>
        set((s) => {
          const list = s.resultsByAssignment[assignmentId];
          if (!list) return s;
          return {
            resultsByAssignment: {
              ...s.resultsByAssignment,
              [assignmentId]: list.map((r) => {
                if (r.id !== resultId) return r;
                const problems: ScoredProblem[] = r.problems.map((p, i) =>
                  i === problemIndex ? { ...p, override: cycleOverride(p.override) } : p,
                );
                return { ...r, problems };
              }),
            },
          };
        }),

      resultsFor: (assignmentId) => get().resultsByAssignment[assignmentId] ?? [],

      getResult: (assignmentId, resultId) =>
        get().resultsByAssignment[assignmentId]?.find((r) => r.id === resultId) ?? null,

      addPending: (scan) => set((s) => ({ pending: [...s.pending, scan] })),

      updatePending: (id, patch) =>
        set((s) => ({ pending: s.pending.map((p) => (p.id === id ? { ...p, ...patch } : p)) })),

      setPendingStatus: (id, status) =>
        set((s) => ({ pending: s.pending.map((p) => (p.id === id ? { ...p, status } : p)) })),

      removePending: (id) => set((s) => ({ pending: s.pending.filter((p) => p.id !== id) })),

      getPending: (id) => get().pending.find((p) => p.id === id) ?? null,

      retryPending: (id) =>
        set((s) => ({
          pending: s.pending.map((p) =>
            p.id === id
              ? { ...p, status: 'waiting', attempts: 0, nextAttemptAt: undefined, lastError: undefined }
              : p,
          ),
        })),

      clearFailedPending: () =>
        set((s) => ({ pending: s.pending.filter((p) => p.status !== 'failed') })),
    }),
    {
      name: 'snapgrade-store',
      version: 2,
      storage: createJSONStorage(() => zustandStorage),
      partialize: (s) => ({
        settings: s.settings,
        assignments: s.assignments,
        currentAssignmentId: s.currentAssignmentId,
        resultsByAssignment: s.resultsByAssignment,
        pending: s.pending,
        showFirstRunTip: s.showFirstRunTip,
      }),
      migrate: (persisted, version) => {
        const state = persisted as Partial<State> & { queue?: unknown };
        // v1 kept an offline-only `queue`; v2 replaced it with the unified
        // pipeline. Those scans predate the status field, so drop them rather
        // than resurrect them in an unknown state.
        if (version < 2) {
          delete state.queue;
          state.pending = [];
        }
        return state as State;
      },
      onRehydrateStorage: () => (state) => {
        if (state) {
          setHapticsEnabled(state.settings.hapticsEnabled);
          // Anything caught mid-flight by a restart is owned by nobody now.
          state.pending = state.pending.map((p) =>
            p.status === 'processing' || p.status === 'grading'
              ? { ...p, status: 'waiting' as const }
              : p,
          );
        }
        useStore.getState().markHydrated();
      },
    },
  ),
);

/** Selector helper used by the summary screen. */
export function selectTotals(result: ScanResult) {
  return computeTotals(result.problems);
}
