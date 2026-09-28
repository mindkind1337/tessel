// Disclosure state of the sidebar's agent rows, kept outside the rows so a
// card that re-renders (sorting, filters) does not reopen what you folded
// (Orca keeps it in its store for the same reason).
import { reactive } from 'vue'

export const childrenFolded = reactive({}) // pane id -> true when its sub-agents are folded
export const olderShown = reactive({}) // pane id -> true when its older sub-agents are shown
