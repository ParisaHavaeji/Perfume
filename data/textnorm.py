"""Text normalization helpers shared across the dataset pipeline."""
import re
import unicodedata


def ascii_fold(s):
    return unicodedata.normalize("NFKD", str(s)).encode("ascii", "ignore").decode()


def norm_key(s):
    """Lowercase alphanumeric key for matching names across sources."""
    return re.sub(r"[^a-z0-9]", "", ascii_fold(s).lower())


def brand_key(s):
    """Brand matching key. "D.S. & Durga" / "DS and Durga" / "DS Durga" must collide."""
    return norm_key(re.sub(r"\b(and|&)\b", " ", str(s).lower()))


def titlecase_slug(slug):
    """"histoires-de-parfums" -> "Histoires De Parfums" (all-caps words kept)."""
    return " ".join(w if w.isupper() else w.capitalize() for w in slug.replace("-", " ").split())


def split_notes(s):
    """Split a "Lemon, Iris and Musk" list into individual note names."""
    return [p.strip().rstrip(".") for p in re.split(r", | and ", s) if p.strip()]
