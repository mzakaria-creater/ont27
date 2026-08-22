// Largest page a table endpoint will serve.
//
// Was 100, hardcoded at five call sites. The panel's tables now offer
// 20/50/100/250/500 rows, and a clamp below the largest offered size would
// have made those last two options quietly dishonest: the selector would say
// 500 and the grid would show 100, with nothing to indicate the difference.
// Raise the ceiling with the selector, or do not offer the option.
export const MAX_PAGE = 500
