/**
 * How likely the opponent is to play each move, from the explorer counts.
 * Shares are smoothed over the legal moves so that a reply played 2 games out
 * of 3 doesn't weigh 66%, and so that the moves the explorer never listed
 * (its answer is capped) still get the games they were played in.
 */
export function moveProbabilities(
    counts: number[],
    totalGames: number,
    legalMoves: number,
    alpha: number,
): number[] {
    const moves = Math.max(legalMoves, counts.length);
    const total = totalGames + alpha * moves;
    if (total <= 0) return counts.map(() => 0);
    return counts.map((count) => (count + alpha) / total);
}

/** Share of the games the listed replies leave out. */
export function uncoveredWeight(probabilities: number[]): number {
    return Math.max(0, 1 - probabilities.reduce((acc, p) => acc + p, 0));
}
