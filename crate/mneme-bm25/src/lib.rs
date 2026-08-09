//! Native BM25 ranking — pure, no napi, no `Shard`, unit-testable on its own.
//!
//! WHY THIS EXISTS
//!   The engine's public API (`MnemeStore`) had vector recall, graph edges, and temporal
//!   operations, but no lexical search at all: nothing computes term frequency, document
//!   frequency, or IDF anywhere in the crate. A caller wanting "find the document containing this
//!   exact part number" had no native path and had to reimplement text search outside the engine.
//!
//! WHY PURE, IN ITS OWN MODULE
//!   Keeping the scoring math free of `Shard`/napi types means it can be tested with plain
//!   `cargo test` against hand-built corpora — no shard file, no native store, no per-platform
//!   binding. The lesson this engine keeps re-learning on the JS side (a rule trapped behind a
//!   heavy import never gets tested) applies just as much in Rust.
//!
//! ALGORITHM
//!   Textbook Robertson/Sparck-Jones BM25 with the standard non-negative IDF variant
//!   (`ln(1 + (N - df + 0.5) / (df + 0.5))`), so a term appearing in most documents still scores
//!   at or above zero rather than going negative and penalizing a match.
//!
//! TOKENIZATION IS DELIBERATELY LANGUAGE-NEUTRAL
//!   Lowercase, Unicode-aware alphanumeric splitting, no stemming, no stopword list. Stemmers and
//!   stopword lists are per-language and exactly the brittle, hand-maintained logic this engine's
//!   JS-side lexical lane already avoids for the same reason: they silently misbehave on whatever
//!   language nobody tested. A prefix/substring layer for partial matches (accent folding,
//!   inflection) can be composed on top later; this module does exact-token BM25 only.

use std::collections::HashMap;

/// One document to be scored: an opaque id plus its tokenizable text.
pub struct Bm25Doc<'a> {
    pub id: u32,
    pub text: &'a str,
}

/// A ranked hit.
#[derive(Debug, Clone, PartialEq)]
pub struct Bm25Hit {
    pub id: u32,
    pub score: f64,
}

/// BM25 free parameters. `k1` controls term-frequency saturation (higher = repeated terms keep
/// adding score for longer); `b` controls length normalization (0 = ignore document length,
/// 1 = fully normalize). 1.5 / 0.75 are the standard defaults from the original Okapi BM25 paper
/// and from every major search engine that has not tuned them for a specific corpus.
#[derive(Debug, Clone, Copy)]
pub struct Bm25Params {
    pub k1: f64,
    pub b: f64,
}

impl Default for Bm25Params {
    fn default() -> Self {
        Bm25Params { k1: 1.5, b: 0.75 }
    }
}

/// Lowercase, Unicode-alphanumeric tokenization. See module docs for why no stemming/stopwords.
pub fn tokenize(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(|t| t.to_string())
        .collect()
}

/// Rank `docs` against `query` by BM25. Two passes over `docs`: the first builds corpus
/// statistics (document frequency per term, average document length); the second scores. Query
/// terms are deduplicated (repeating a term in the query does not double-count its IDF, matching
/// standard BM25 — term frequency WITHIN A DOCUMENT is what `k1` rewards, not within the query).
///
/// Returns hits with score > 0, sorted best-first. A document matching none of the query's terms
/// is not just low-scored, it is absent — callers should not have to filter a zero-score floor
/// themselves.
pub fn bm25_search(
    docs: &[Bm25Doc],
    query: &str,
    top_k: usize,
    params: Bm25Params,
) -> Vec<Bm25Hit> {
    let query_terms: Vec<String> = {
        let mut seen = std::collections::HashSet::new();
        tokenize(query)
            .into_iter()
            .filter(|t| seen.insert(t.clone()))
            .collect()
    };
    if query_terms.is_empty() || docs.is_empty() {
        return Vec::new();
    }

    // Pass 1: corpus statistics. `doc_freq` counts DOCUMENTS containing a term at least once
    // (not total occurrences) -- that distinction is what makes it a document frequency rather
    // than a collection frequency, and BM25's IDF is defined over the former. Tokenizing each
    // document once here and reusing the result in pass 2 avoids re-tokenizing the whole corpus
    // per query term.
    let n = docs.len() as f64;
    let mut doc_freq: HashMap<String, u32> = HashMap::new();
    let mut doc_lens: Vec<usize> = Vec::with_capacity(docs.len());
    let mut total_len: u64 = 0;
    let tokenized: Vec<Vec<String>> = docs
        .iter()
        .map(|d| {
            let toks = tokenize(d.text);
            let mut seen_in_doc = std::collections::HashSet::new();
            for t in &toks {
                if seen_in_doc.insert(t.as_str()) {
                    *doc_freq.entry(t.clone()).or_insert(0) += 1;
                }
            }
            total_len += toks.len() as u64;
            doc_lens.push(toks.len());
            toks
        })
        .collect();

    let avgdl = if docs.is_empty() {
        0.0
    } else {
        total_len as f64 / n
    };

    // Per-term IDF, computed once (not per document) -- BM25's IDF depends only on the corpus.
    let mut idf: HashMap<&str, f64> = HashMap::new();
    for qt in &query_terms {
        let df = *doc_freq.get(qt.as_str()).unwrap_or(&0) as f64;
        // ln(1 + (N - df + 0.5) / (df + 0.5)): the "+1" variant. Plain Robertson IDF
        // (ln((N-df+0.5)/(df+0.5))) goes negative once df > N/2, which would make a common-but-
        // present term SUBTRACT from a document's score -- exactly backwards for "does this
        // document contain what was asked for".
        let value = (1.0 + (n - df + 0.5) / (df + 0.5)).ln();
        idf.insert(qt.as_str(), value);
    }

    // Pass 2: score.
    let mut hits: Vec<Bm25Hit> = Vec::new();
    for (i, doc) in docs.iter().enumerate() {
        let toks = &tokenized[i];
        if toks.is_empty() {
            continue;
        }
        let mut tf: HashMap<&str, u32> = HashMap::new();
        for t in toks {
            *tf.entry(t.as_str()).or_insert(0) += 1;
        }
        let doclen = doc_lens[i] as f64;
        let mut score = 0.0;
        for qt in &query_terms {
            let f = *tf.get(qt.as_str()).unwrap_or(&0) as f64;
            if f == 0.0 {
                continue;
            }
            let term_idf = idf[qt.as_str()];
            let numerator = f * (params.k1 + 1.0);
            let denominator = f + params.k1 * (1.0 - params.b + params.b * doclen / avgdl.max(1.0));
            score += term_idf * (numerator / denominator);
        }
        if score > 0.0 {
            hits.push(Bm25Hit { id: doc.id, score });
        }
    }

    hits.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    hits.truncate(top_k);
    hits
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(id: u32, text: &'static str) -> Bm25Doc<'static> {
        Bm25Doc { id, text }
    }

    #[test]
    fn only_documents_containing_the_term_are_returned_at_all() {
        let docs = vec![
            doc(1, "the quarterly revenue report shows growth"),
            doc(2, "warranty terms cover 36 months of parts and labor"),
            doc(3, "annual maintenance schedule and site visit notes"),
        ];
        let hits = bm25_search(&docs, "warranty", 10, Bm25Params::default());
        assert_eq!(hits.len(), 1, "exactly one document contains the term");
        assert_eq!(hits[0].id, 2);
    }

    #[test]
    fn repeated_mentions_outrank_a_single_passing_mention() {
        // Bag-of-words is intentional and honest about its limits: it cannot tell "covers the
        // warranty in depth" from "warranty is not covered" -- both contain the token. What it
        // DOES correctly reward is a document that is repeatedly and centrally about the term
        // (higher term frequency) over one where the term appears once in passing.
        let docs = vec![
            doc(1, "the meeting briefly touched on warranty near the end"),
            doc(
                2,
                "warranty terms: the warranty covers parts and labor, the warranty period is \
                 36 months, and warranty claims are filed online",
            ),
        ];
        let hits = bm25_search(&docs, "warranty", 10, Bm25Params::default());
        assert_eq!(
            hits[0].id, 2,
            "the document centrally about warranty must outrank a single mention"
        );
    }

    #[test]
    fn rare_terms_outrank_common_terms_at_equal_frequency() {
        // "the" appears in every document (df=N); "zylotech" appears in exactly one.
        // A query for the rare term must score higher via IDF, even though both queries would
        // otherwise see one term-frequency-one match.
        let docs = vec![
            doc(1, "the firm signed a contract with zylotech industries"),
            doc(2, "the terms of the agreement were finalized on the date"),
            doc(3, "the delivery of the parts arrived on the scheduled date"),
        ];
        let rare = bm25_search(&docs, "zylotech", 10, Bm25Params::default());
        let common = bm25_search(&docs, "the", 10, Bm25Params::default());
        assert_eq!(rare[0].id, 1);
        // "the" appears in ALL docs (df == N), so IDF collapses toward its floor and every
        // matching document should score far lower than the rare-term hit on doc 1.
        assert!(
            rare[0].score > common[0].score,
            "rare-term match ({}) must outscore a match on a term present in every document ({})",
            rare[0].score,
            common[0].score
        );
    }

    #[test]
    fn empty_query_or_empty_corpus_returns_nothing_not_a_panic() {
        let docs = vec![doc(1, "some text")];
        assert!(bm25_search(&docs, "", 10, Bm25Params::default()).is_empty());
        assert!(bm25_search(&[], "warranty", 10, Bm25Params::default()).is_empty());
        assert!(bm25_search(&docs, "   ", 10, Bm25Params::default()).is_empty());
    }

    #[test]
    fn a_query_term_absent_from_every_document_matches_nothing() {
        let docs = vec![doc(1, "alpha beta gamma"), doc(2, "delta epsilon zeta")];
        assert!(bm25_search(&docs, "omega", 10, Bm25Params::default()).is_empty());
    }

    #[test]
    fn top_k_truncates_and_stays_sorted_best_first() {
        let docs: Vec<Bm25Doc> = (1..=20)
            .map(|i| Bm25Doc {
                id: i,
                text: "warranty terms and conditions apply here",
            })
            .collect();
        let hits = bm25_search(&docs, "warranty terms", 5, Bm25Params::default());
        assert_eq!(hits.len(), 5);
        for w in hits.windows(2) {
            assert!(
                w[0].score >= w[1].score,
                "results must be sorted best-first"
            );
        }
    }

    #[test]
    fn length_normalization_favors_the_shorter_focused_document() {
        // Same absolute term frequency (1 occurrence of "warranty"), but doc 2 is much longer --
        // `b` should penalize the diluted match relative to the focused one.
        let long_padding = "filler word ".repeat(200);
        let short_doc = format!("warranty {}", "policy details end");
        let long_doc = format!("warranty {}{}", long_padding, "policy details end");
        let docs = vec![
            Bm25Doc {
                id: 1,
                text: &short_doc,
            },
            Bm25Doc {
                id: 2,
                text: &long_doc,
            },
        ];
        let hits = bm25_search(&docs, "warranty", 10, Bm25Params::default());
        assert_eq!(
            hits[0].id, 1,
            "the short, focused document should outrank the diluted long one"
        );
    }

    #[test]
    fn repeating_a_term_in_the_query_does_not_double_count_its_idf() {
        let docs = vec![
            doc(1, "warranty warranty warranty"),
            doc(2, "warranty once"),
        ];
        let once = bm25_search(&docs, "warranty", 10, Bm25Params::default());
        let repeated = bm25_search(
            &docs,
            "warranty warranty warranty",
            10,
            Bm25Params::default(),
        );
        // Same document set, same underlying term -- repeating it in the QUERY must not change
        // the ranking outcome (BM25 rewards term frequency in the DOCUMENT via k1, not in the
        // query by re-adding IDF for a term already seen).
        assert_eq!(once, repeated);
    }

    #[test]
    fn tokenizer_is_language_neutral_and_handles_unicode() {
        // No stemming, no stopwords -- but real Unicode letters must still tokenize as words,
        // not get silently dropped as "non-alphanumeric".
        let toks = tokenize("Größe: 94% Effizienz, Ladesäule–Nr.7");
        assert!(toks.contains(&"größe".to_string()));
        assert!(toks.contains(&"94".to_string()));
        assert!(toks.contains(&"effizienz".to_string()));
        assert!(toks.contains(&"ladesäule".to_string()));
        assert!(toks.contains(&"7".to_string()));
    }
}
