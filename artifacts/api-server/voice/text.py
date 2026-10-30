"""Text preparation used by the accepted uncut Hungarian voice approach."""

import re
import unicodedata


def prepare_text(text, vocabulary):
    text = unicodedata.normalize("NFC", text).lower()
    text = text.translate(str.maketrans({
        "“": '"', "”": '"', "‘": "'", "’": "'",
        "\n": " ", "\t": " ", "/": " per ", "=": " egyenlő ", "+": " plusz ",
    }))
    text = re.sub(r"[*_`#]", "", text)
    # Decorative symbols are not speech. Never silently drop unknown letters.
    text = "".join(c for c in text if c in vocabulary or
                   unicodedata.category(c)[0] not in {"S", "C"})
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        raise ValueError("Nincs felolvasható szöveg.")
    unknown = set(text) - vocabulary
    if unknown:
        raise ValueError("A saját hangmodell ezt a szöveget még nem tudja biztonságosan kimondani.")
    # Preserve the accepted lead-in and the complete reference-based approach.
    return text if text.startswith("rendben.") else f"rendben. {text}"
