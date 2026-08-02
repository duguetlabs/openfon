"""WER / CER scoring with per-language normalisation.

The normaliser exists so that the number we report reflects *recognition*
errors and not formatting disagreements between two engines that spell the
same utterance differently. Everything here is applied identically to the
hypothesis and the reference.

Shared rules
  NFKC, casefold, strip punctuation, collapse whitespace
  digits -> words in the utterance language (so "15" == "fünfzehn")

Per language
  de  ss/ß unified; ae/oe/ue accepted for ä/ö/ü (transliteration, not an error)
  sv/da/fi/nl/it/fr/es  diacritics KEPT — they are phonemic, and folding them
                        would hide real errors
  ru  ё -> е (standard Russian orthographic practice)

Input: a JSONL of {"id","lang","reference","hypothesis"} records.
Output: per-language and per-condition WER/CER plus a per-utterance CSV.

  python score_wer.py --hyp results.jsonl --by lang,condition
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import unicodedata
from collections import defaultdict
from pathlib import Path

import jiwer
from num2words import num2words

# FLEURS config / BCP-47-ish tag -> num2words language code.
NUM_LANG = {
    "en": "en", "de": "de", "fr": "fr", "es": "es", "nl": "nl",
    "it": "it", "sv": "sv", "da": "da", "fi": "fi", "ru": "ru",
}

PUNCT = re.compile(r"[^\w\s]", re.UNICODE)
WS = re.compile(r"\s+")
NUM = re.compile(r"\d+")


def base_lang(lang: str) -> str:
    return lang.split("_")[0].split("-")[0].lower()


def spell_numbers(text: str, lang: str) -> str:
    code = NUM_LANG.get(base_lang(lang))
    if not code:
        return text

    def sub(m: re.Match) -> str:
        try:
            return " " + num2words(int(m.group()), lang=code) + " "
        except Exception:
            return m.group()

    return NUM.sub(sub, text)


def normalize(text: str, lang: str) -> str:
    lg = base_lang(lang)
    t = unicodedata.normalize("NFKC", text).casefold()
    t = spell_numbers(t, lang)
    if lg == "de":
        t = t.replace("ß", "ss")
        # Accept the ASCII transliteration in either direction.
        for uml, ascii_ in (("ä", "ae"), ("ö", "oe"), ("ü", "ue")):
            t = t.replace(uml, ascii_)
    elif lg == "ru":
        t = t.replace("ё", "е")
    t = PUNCT.sub(" ", t)
    # num2words emits hyphens (twenty-four) that the punctuation strip already
    # turned into spaces; collapse whatever is left.
    return WS.sub(" ", t).strip()


def score(records: list[dict], keys: list[str]) -> list[dict]:
    groups: dict[tuple, list[dict]] = defaultdict(list)
    for r in records:
        groups[tuple(r.get(k, "") for k in keys)].append(r)

    rows = []
    for key, rs in sorted(groups.items()):
        lang = next((v for k, v in zip(keys, key) if k == "lang"), rs[0].get("lang", "en"))
        refs = [normalize(r["reference"], lang) for r in rs]
        hyps = [normalize(r["hypothesis"], lang) for r in rs]
        wo = jiwer.process_words(refs, hyps)
        co = jiwer.process_characters(refs, hyps)
        rows.append({
            **dict(zip(keys, key)),
            "n": len(rs),
            "wer": round(wo.wer * 100, 2),
            "cer": round(co.cer * 100, 2),
            "sub": wo.substitutions,
            "del": wo.deletions,
            "ins": wo.insertions,
        })
    return rows


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--hyp", required=True, help="JSONL: id, lang, condition, reference, hypothesis")
    p.add_argument("--by", default="lang,condition")
    p.add_argument("--per-utt", help="optional CSV of per-utterance scores")
    args = p.parse_args()

    records = [json.loads(l) for l in Path(args.hyp).read_text().splitlines() if l.strip()]
    keys = [k.strip() for k in args.by.split(",") if k.strip()]

    rows = score(records, keys)
    w = csv.DictWriter(sys.stdout, fieldnames=list(rows[0].keys()))
    w.writeheader()
    w.writerows(rows)

    if args.per_utt:
        with open(args.per_utt, "w", newline="") as f:
            uw = csv.DictWriter(f, fieldnames=["id", "lang", "condition", "wer", "cer"])
            uw.writeheader()
            for r in records:
                lang = r.get("lang", "en")
                ref, hyp = normalize(r["reference"], lang), normalize(r["hypothesis"], lang)
                uw.writerow({
                    "id": r["id"], "lang": lang, "condition": r.get("condition", ""),
                    "wer": round(jiwer.wer(ref, hyp) * 100, 2),
                    "cer": round(jiwer.cer(ref, hyp) * 100, 2),
                })


if __name__ == "__main__":
    main()
