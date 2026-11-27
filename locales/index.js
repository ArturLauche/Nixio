import * as english from "./en.js"
import * as japanese from "./ja.js"
import * as vietnamese from "./vi.js"

// Adding a language is one module plus one line here: the header picker, the parity test and the
// runtime lookup all read this list. Vietnamese leads because it is the default and the fallback.
export const LOCALE_MODULES = [vietnamese, english, japanese]

export const DEFAULT_LOCALE = vietnamese.meta.code

export const LOCALES = Object.fromEntries(LOCALE_MODULES.map(({ meta }) => [meta.code, meta]))

export const CATALOGUES = Object.fromEntries(LOCALE_MODULES.map(({ meta, messages }) => [meta.code, messages]))
