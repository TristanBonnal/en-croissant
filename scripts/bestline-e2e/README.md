# Best line end-to-end checks

These run the feature with a real UCI engine. The Lichess explorer needs a token, so it is replaced by a
book made up from an engine (`engineBook.ts`) or, for the decision-quality simulation, by sampled games of
a made-up opening whose truth is known (`src/utils/tests/bestLineWorld.ts`).

The engine ones are skipped unless `E2E_ENGINE` is set (`E2E_FAST` / `E2E_PRECISE` set the two depths):

    E2E_ENGINE=/path/to/stockfish E2E_FAST=14 E2E_PRECISE=18 pnpm vitest run --reporter=verbose scripts/bestline-e2e

(`--reporter=verbose` is needed to see the `console.log` lines when run from a coding agent.)

- `bestLine.e2e.test.ts`: the search alone, full tree, extension from the end of the line, live; prints the time spent per analysis purpose.
- `runner.e2e.test.ts`: the whole runner (engines, caches, report) and the moves added to the board's tree: search, extension, replaced move, live analysis, stopping a search. The engine is given 16 threads and 2 GB like the app's, so the search runs on 4 engines of 4 threads; `E2E_POOL=off` gives it no thread and hash options and it runs alone with all its threads (how it ran before the pool), `E2E_CORES`/`E2E_THREADS` change the machine, `E2E_MOVES`/`E2E_REACH` the search, `E2E_EXPLORER_MS` adds network time to each explorer request, and `E2E_TRACE=1` (or `full`) prints how many engines were busy over time.
- `pool.e2e.test.ts`: records the analyses a search asks for and replays them on one engine with many threads, or on several with a few each (`E2E_POOLS=1x16,4x4,...`). On 16 threads: 1 engine of 16 threads 40 s, 4 of 4 threads 13 s, 16 of 1 thread 6 s for the same 96 analyses.
- `candidates.e2e.test.ts`: how many engine moves are within the tolerance in typical openings, and what asking for more lines costs.
- `depth.e2e.test.ts`: engine time per depth and MultiPV.

`quality.sim.test.ts` needs no engine. It measures how good the moves of the search are, in points of expected score over the
most played sound move, against simple rules (best raw score) and the best a careful player could do (the oracle), on
random made-up openings. Run it with `E2E_SIM=1` (`E2E_SEEDS`, `E2E_PLIES`, `E2E_NOISE`, `E2E_SCALE`, `E2E_MINGAMES`,
`E2E_MINMOVE`, `E2E_REACH` change the worlds and the settings; `E2E_SWEEP=1` compares `risk` and `shrinkage`).
