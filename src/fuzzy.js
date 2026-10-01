// src/fuzzy.js — PI'S SLASH-COMMAND FILTER, ported from pi 0.86.1
// (<pi>/node_modules/@earendil-works/pi-tui/dist/fuzzy.js:17-140, verbatim
// algorithm). pi's CombinedAutocompleteProvider filters the slash-command menu
// with fuzzyFilter (dist/autocomplete.js:214-232) — NOT a substring includes():
// every query character must appear IN ORDER (not necessarily consecutive), all
// whitespace/slash-separated tokens must match, and the list is SORTED
// best-match-first (lower score = better). Imported into the slash dialog so the
// FIRST row Tab applies is the same row pi would complete for that prefix.
//
// Exact match → "-100 score" wins; consecutive runs get -5/char; a word boundary
// (start, whitespace, -  _  .  /  :) gets -10; gaps cost +2/char; later
// positions cost +0.1. A pure alpha/digit swap (e.g. "model1" vs "1model") still
// matches with a +5 penalty.

/** pi's fuzzyMatch: does every char of `query` appear in `text`, in order?
 *  Lower score = better match. */
export function fuzzyMatch(query, text) {
  const queryLower = query.toLowerCase();
  const textLower = text.toLowerCase();
  const matchQuery = (normalizedQuery) => {
    if (normalizedQuery.length === 0) {
      return { matches: true, score: 0 };
    }
    if (normalizedQuery.length > textLower.length) {
      return { matches: false, score: 0 };
    }
    let queryIndex = 0;
    let score = 0;
    let lastMatchIndex = -1;
    let consecutiveMatches = 0;
    while (queryIndex < normalizedQuery.length) {
      const i = textLower.indexOf(normalizedQuery[queryIndex], lastMatchIndex + 1);
      if (i === -1) break;
      const isWordBoundary = i === 0 || /[\s\-_./:]/.test(textLower[i - 1]);
      // Reward consecutive matches
      if (lastMatchIndex === i - 1) {
        consecutiveMatches++;
        score -= consecutiveMatches * 5;
      } else {
        consecutiveMatches = 0;
        // Penalize gaps
        if (lastMatchIndex >= 0) {
          score += (i - lastMatchIndex - 1) * 2;
        }
      }
      // Reward word boundary matches
      if (isWordBoundary) {
        score -= 10;
      }
      // Slight penalty for later matches
      score += i * 0.1;
      lastMatchIndex = i;
      queryIndex++;
    }
    if (queryIndex < normalizedQuery.length) {
      return { matches: false, score: 0 };
    }
    if (normalizedQuery === textLower) {
      score -= 100;
    }
    return { matches: true, score };
  };
  const primaryMatch = matchQuery(queryLower);
  if (primaryMatch.matches) {
    return primaryMatch;
  }
  const alphaNumericMatch = queryLower.match(/^(?<letters>[a-z]+)(?<digits>[0-9]+)$/);
  const numericAlphaMatch = queryLower.match(/^(?<digits>[0-9]+)(?<letters>[a-z]+)$/);
  const swappedQuery = alphaNumericMatch
    ? `${alphaNumericMatch.groups?.digits ?? ""}${alphaNumericMatch.groups?.letters ?? ""}`
    : numericAlphaMatch
      ? `${numericAlphaMatch.groups?.letters ?? ""}${numericAlphaMatch.groups?.digits ?? ""}`
      : "";
  if (!swappedQuery) {
    return primaryMatch;
  }
  const swappedMatch = matchQuery(swappedQuery);
  if (!swappedMatch.matches) {
    return primaryMatch;
  }
  return { matches: true, score: swappedMatch.score + 5 };
}

/** pi's fuzzyFilter: whitespace- and slash-separated tokens, ALL must match;
 *  results sorted by total score (best first). An empty query → the items
 *  unchanged (a bare "/" still shows the FULL list, pi autocomplete.js:206-211). */
export function fuzzyFilter(items, query, getText) {
  if (!query.trim()) {
    return items;
  }
  const tokens = query
    .trim()
    .split(/[\s/]+/)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) {
    return items;
  }
  const results = [];
  for (const item of items) {
    const text = getText(item);
    let totalScore = 0;
    let allMatch = true;
    for (const token of tokens) {
      const match = fuzzyMatch(token, text);
      if (match.matches) {
        totalScore += match.score;
      } else {
        allMatch = false;
        break;
      }
    }
    if (allMatch) {
      results.push({ item, totalScore });
    }
  }
  results.sort((a, b) => a.totalScore - b.totalScore);
  return results.map((r) => r.item);
}
