// Abbreviations that end with period but aren't sentence boundaries
const COMMON_ABBREVIATIONS = new Set([
  "mr",
  "mrs",
  "ms",
  "dr",
  "prof",
  "sr",
  "jr",
  "vs",
  "etc",
  "inc",
  "ltd",
  "co",
  "st",
  "ave",
  "blvd",
  "rd",
  "jan",
  "feb",
  "mar",
  "apr",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
  "e.g",
  "i.e",
  "cf",
  "al",
  "et",
  "no",
  "vol",
  "pp",
  "fig",
  "approx",
  "dept",
  "est",
  "govt",
  "misc",
  "ref",
]);

interface SentenceResult {
  sentences: string[];
  remainder: string;
}

/**
 * Strips code blocks (content inside triple backticks) from text.
 * Returns text with code blocks removed, preserving surrounding content.
 * Incomplete code blocks (unclosed) are kept in the remainder.
 */
function stripCodeBlocks(text: string): { cleaned: string; hasUnclosedBlock: boolean } {
  const codeBlockPattern = /```[\s\S]*?```/g;
  const unclosedPattern = /```[^`]*$/;

  // Check for unclosed code block at the end
  const hasUnclosedBlock = unclosedPattern.test(text);

  // Remove complete code blocks
  const cleaned = text.replace(codeBlockPattern, " ");

  return { cleaned, hasUnclosedBlock };
}

/**
 * Checks if a period at a given position is likely part of an abbreviation.
 */
function isAbbreviation(text: string, periodIndex: number): boolean {
  // Find the word before the period
  let wordStart = periodIndex - 1;
  while (wordStart >= 0 && /[a-zA-Z.]/.test(text[wordStart])) {
    wordStart--;
  }
  wordStart++;

  const word = text.slice(wordStart, periodIndex).toLowerCase();

  // Check against known abbreviations
  if (COMMON_ABBREVIATIONS.has(word)) {
    return true;
  }

  // Single letter followed by period is likely an initial (e.g., "J. Smith")
  if (word.length === 1 && /[A-Za-z]/.test(word)) {
    return true;
  }

  // Check for patterns like "U.S." or "U.S.A."
  if (/^[a-z](\.[a-z])+$/i.test(word + ".")) {
    return true;
  }

  return false;
}

/**
 * Checks if a period at a given position is part of a decimal number.
 */
function isDecimalNumber(text: string, periodIndex: number): boolean {
  const before = periodIndex > 0 ? text[periodIndex - 1] : "";
  const after = periodIndex < text.length - 1 ? text[periodIndex + 1] : "";

  // Period between digits is a decimal
  return /\d/.test(before) && /\d/.test(after);
}

/**
 * Checks if a period is part of a URL or file path.
 */
function isUrlOrPath(text: string, periodIndex: number): boolean {
  // Look for URL patterns before the period
  const beforeText = text.slice(Math.max(0, periodIndex - 50), periodIndex);
  if (/https?:\/\/\S*$/.test(beforeText)) {
    return true;
  }
  if (/www\.\S*$/.test(beforeText)) {
    return true;
  }
  // File extensions - period followed by 2-4 letters then whitespace/end
  const afterText = text.slice(periodIndex + 1, periodIndex + 6);
  if (/^[a-zA-Z]{2,4}(\s|$)/.test(afterText)) {
    // Could be file extension, but also could be end of sentence
    // Only treat as file extension if there's more content after without space
    const match = afterText.match(/^[a-zA-Z]{2,4}/);
    if (match && periodIndex + 1 + match[0].length < text.length) {
      const nextChar = text[periodIndex + 1 + match[0].length];
      if (nextChar && !/\s/.test(nextChar)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Checks if this is a valid sentence boundary.
 * A boundary is valid if it's followed by whitespace and either:
 * - End of text (with reasonable length)
 * - A capital letter (new sentence)
 * - A quote or parenthesis
 */
function isValidBoundary(text: string, terminatorIndex: number): boolean {
  const afterIndex = terminatorIndex + 1;

  // Must have something after the terminator to check
  if (afterIndex >= text.length) {
    return false;
  }

  // Check for whitespace after terminator
  if (!/\s/.test(text[afterIndex])) {
    // Special case: closing quote or parenthesis followed by space
    if (/["')\]]/.test(text[afterIndex])) {
      const nextIndex = afterIndex + 1;
      if (nextIndex < text.length && /\s/.test(text[nextIndex])) {
        return true;
      }
    }
    return false;
  }

  // Find next non-whitespace character
  let nextNonSpace = afterIndex + 1;
  while (nextNonSpace < text.length && /\s/.test(text[nextNonSpace])) {
    nextNonSpace++;
  }

  // If we reached the end, it's a boundary only if there's decent content
  if (nextNonSpace >= text.length) {
    return false; // Keep buffering until we see what comes next
  }

  // Next char should be capital letter, quote, or opening bracket for new sentence
  const nextChar = text[nextNonSpace];
  return /[A-Z"'([]/.test(nextChar);
}

/**
 * Extracts complete sentences from text.
 * Returns an array of complete sentences and the remaining incomplete text.
 */
export function extractSentences(text: string): SentenceResult {
  if (!text || text.trim().length === 0) {
    return { sentences: [], remainder: text };
  }

  // Strip code blocks for sentence detection
  const { cleaned, hasUnclosedBlock } = stripCodeBlocks(text);

  // If there's an unclosed code block, don't extract any sentences yet
  if (hasUnclosedBlock) {
    return { sentences: [], remainder: text };
  }

  const sentences: string[] = [];
  let lastSentenceEnd = 0;

  // Sentence terminators
  const terminators = /[.!?]/g;
  let match: RegExpExecArray | null;

  while ((match = terminators.exec(cleaned)) !== null) {
    const index = match.index;
    const terminator = match[0];

    // Skip if this is an ellipsis (...)
    if (terminator === "." && cleaned.slice(index, index + 3) === "...") {
      // Ellipsis could be sentence end if followed by space and capital
      if (isValidBoundary(cleaned, index + 2)) {
        const sentence = cleaned.slice(lastSentenceEnd, index + 3).trim();
        if (sentence.length > 0) {
          sentences.push(sentence);
          lastSentenceEnd = index + 3;
        }
      }
      terminators.lastIndex = index + 3;
      continue;
    }

    // Skip periods that are part of abbreviations, decimals, or URLs
    if (terminator === ".") {
      if (isAbbreviation(cleaned, index)) continue;
      if (isDecimalNumber(cleaned, index)) continue;
      if (isUrlOrPath(cleaned, index)) continue;
    }

    // Check if this is a valid sentence boundary
    if (isValidBoundary(cleaned, index)) {
      const sentence = cleaned.slice(lastSentenceEnd, index + 1).trim();
      if (sentence.length > 0) {
        sentences.push(sentence);
        lastSentenceEnd = index + 1;
      }
    }
  }

  // Remainder is everything after the last sentence
  const remainder = text.slice(lastSentenceEnd).trim();

  return { sentences, remainder };
}
