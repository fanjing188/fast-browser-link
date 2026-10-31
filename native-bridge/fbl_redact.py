"""Remove credentials and local paths from maintenance command errors."""

import re


def redact(text):
    text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", str(text))
    if re.search(
        r"(?i)\b(?:authorization|cookie|password|passwd|secret|token|key|client_secret|secret_key|id_token|(?:api|access|auth|refresh)[_-]?(?:key|token))\b\s*[\"\x27 :=]",
        text,
    ):
        return "[redacted sensitive line]"
    text = re.sub(
        r"(?i)\bBearer\s+\S+|\b(?:sk-|gh[pousr]_|github_pat_|xox[baprs]-)[A-Za-z0-9_.-]+|\bAKIA[A-Z0-9]{16}\b",
        "[redacted]",
        text,
    )
    text = re.sub(r"(?<![\w])[A-Za-z0-9_+/=-]{24,}(?![\w])", "[redacted]", text)
    text = re.sub(r"https?://[^\s]+", "[url]", text)
    text = re.sub(r"(?:/Users/|/home/)[^\s\"\x27:]+", "[path]", text)
    return "".join(char for char in text if char == "\t" or ord(char) >= 32)[:2048]
